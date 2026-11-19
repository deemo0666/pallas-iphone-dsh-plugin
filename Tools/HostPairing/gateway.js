import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, createServer } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import ssh2 from 'ssh2';
import { ClaudeBridge, parseCommand } from './claude-desktop.js';
import { meshFor } from './mesh.js';

const hash = (data) => createHash('sha256').update(data).digest();
const keyId = (data) => hash(data).toString('hex');

export function generateSSHKey() {
  // ssh2 1.17.0 strips leading zero bytes from generated Ed25519 public keys.
  // Verify the result before saving a host identity that phones will pin.
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = ssh2.utils.generateKeyPairSync('ed25519').private;
    if (!(ssh2.utils.parseKey(key) instanceof Error)) return key;
  }
  throw new Error('Failed to generate a usable Ed25519 key');
}

const tailnet = (address) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address);
const lan = (address) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address);

// Every address a phone may reach this computer on: private LAN addresses first, then the tailnet
// address while Tailscale is up (100.64.0.0/10).
export function reachableAddresses() {
  const all = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === 'IPv4' && !n.internal)
    .map((n) => n.address);
  return [...new Set([...all.filter(lan), ...all.filter(tailnet)])];
}

// A dedicated SSH server for paired device keys, the DSH web forward, the Claude
// bridge and the phone-initiated control channel. Each command is handled here.
export class Gateway {
  constructor(dir, endpoint, forwardedPorts = new Set(), candidates = reachableAddresses, phoneControl = null) {
    this.dir = dir;
    this.candidates = candidates;
    this.relays = new Map();
    this.endpoint = endpoint;
    this.clients = new Map();
    this.forwardedPorts = forwardedPorts;
    this.claude = new ClaudeBridge(dir);
    this.mesh = meshFor(dir);
    this.phoneControl = phoneControl;
    mkdirSync(join(dir, 'devices'), { recursive: true, mode: 0o700 });
    const file = join(dir, 'host.key');
    if (!existsSync(file)) {
      try {
        writeFileSync(file, generateSSHKey(), {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    this.hostKey = readFileSync(file);
    this.fingerprint = hash(ssh2.utils.parseKey(this.hostKey).getPublicSSH())
      .toString('base64')
      .replace(/=+$/, '');
    this.server = new ssh2.Server({ hostKeys: [this.hostKey] }, (client) => this.accept(client));
  }

  async listen(address, port) {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, address, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    // Profiles sharing DSH_HOME share the device registry. Revoking in either
    // desktop window must also tear down streams owned by the other process.
    this.deviceWatcher = watch(join(this.dir, 'devices'), () => this.disconnectRevoked());
    this.deviceWatcher.on('error', () => this.close());
    // The same server answers on this computer's other addresses (other LANs, the tailnet), so a
    // phone picks whichever it reaches: same host key, same device keys. Addresses come and go
    // (Tailscale up later, Wi-Fi changed), so check again every 30 seconds.
    const bound = this.server.address().port;
    // Resolves once each new listener is up or has failed, so the first invite already lists them.
    const refresh = () => {
      if (this.closed) return [];
      const started = [];
      const wanted = new Set(this.candidates().filter((other) => other !== address));
      for (const [other, server] of this.relays) {
        if (!wanted.has(other)) { server.close(); this.relays.delete(other); }
      }
      for (const other of wanted) {
        if (this.relays.has(other)) continue;
        const server = createServer((socket) => this.server.injectSocket(socket));
        this.relays.set(other, server);
        server.on('error', () => {
          server.close();
          if (this.relays.get(other) === server) this.relays.delete(other);
        });
        started.push(new Promise((resolve) => {
          server.once('listening', resolve).once('error', resolve);
          server.listen(bound, other);
        }));
      }
      return started;
    };
    await Promise.all(refresh());
    // The Pallas mesh: reachable from anywhere once paired, same host and device keys.
    this.mesh.attach(this, bound);
    this.relayTimer = setInterval(refresh, 30000);
    this.relayTimer.unref();
  }

  /** Where this server answers now, in the order a phone should prefer: the bound address, other LANs, the tailnet. */
  addresses() {
    const listening = [...this.relays].filter(([, server]) => server.listening).map(([other]) => other);
    const mesh = this.mesh.ip && !listening.includes(this.mesh.ip) ? [this.mesh.ip] : [];
    return [this.server.address().address, ...listening.filter((a) => !tailnet(a)), ...mesh, ...listening.filter(tailnet)];
  }

  invite() {
    const secret = randomBytes(24).toString('base64url');
    this.invitation = { secret, expires: Date.now() + 120000 };
    const { port } = this.server.address();
    const [host, ...others] = this.addresses();
    return (
      'dshlocal://lan/pair#' +
      new URLSearchParams({
        v: '1',
        host,
        ...(others.length ? { alt: others.join(',') } : {}),
        port,
        pin: this.fingerprint,
        invite: secret,
        name: hostname(),
      })
    );
  }

  devices() {
    return readdirSync(join(this.dir, 'devices')).filter((id) => /^[a-f0-9]{64}$/.test(id));
  }
  authorized(id) {
    return existsSync(join(this.dir, 'devices', id));
  }

  revoke(id) {
    if (!/^[a-f0-9]{64}$/.test(id) || !this.authorized(id)) return false;
    unlinkSync(join(this.dir, 'devices', id));
    this.disconnectRevoked();
    return true;
  }

  disconnectRevoked() {
    for (const entry of this.clients.values()) {
      if (entry.id && !this.authorized(entry.id)) entry.drop();
    }
  }

  accept(client) {
    const sockets = new Set();
    const entry = {
      id: null,
      drop: () => {
        for (const socket of sockets) socket.destroy();
        client.end();
      },
    };
    this.clients.set(client, entry);
    client.on('error', () => entry.drop());
    client.on('close', () => {
      this.clients.delete(client);
      for (const socket of sockets) socket.destroy();
    });
    client.on('authentication', (auth) => {
      if (auth.method !== 'publickey' || auth.key.algo !== 'ssh-ed25519')
        return auth.reject(['publickey']);
      const id = keyId(auth.key.data);
      const invite = this.invitation;
      const pairing = invite && Date.now() < invite.expires && auth.username === 'pair-' + invite.secret;
      if (!pairing && !(auth.username === 'device-' + id.slice(0, 16) && this.authorized(id)))
        return auth.reject();
      if (!auth.signature) return auth.accept(); // public-key probe, never consumes an invite
      const key = ssh2.utils.parseKey(auth.key.data);
      if (key instanceof Error || key.verify(auth.blob, auth.signature) !== true) return auth.reject();
      if (pairing) {
        try {
          writeFileSync(join(this.dir, 'devices', id), '', { mode: 0o600 });
        } catch {
          return auth.reject();
        }
        this.invitation = null;
      }
      entry.id = id;
      auth.accept();
    });
    client.on('ready', () => {
      client.on('session', (accept, reject) => {
        if (!this.authorized(entry.id)) return reject();
        accept().on('exec', (acceptExec, rejectExec, info) => {
          if (!this.authorized(entry.id)) return rejectExec();
          const claude = parseCommand(info.command);
          if (claude) return this.runClaude(claude, acceptExec(), entry);
          if (info.command === "sh -lc 'dsh-local-mesh-invite'") return this.meshInvite(acceptExec());
          if (info.command === 'dsh-local-iphone' && this.phoneControl?.settings.enabled) {
            return this.phoneControl.attach(entry.id, acceptExec(), () => this.authorized(entry.id));
          }
          if (info.command !== "sh -lc 'dsh-local-endpoint'") return rejectExec();
          const channel = acceptExec();
          try {
            const url = this.endpoint();
            channel.write(
              JSON.stringify({
                port: Number(url.port),
                token: url.searchParams.get('token'),
                addresses: this.addresses(),
                // Phones before the address list read one tailnet address here.
                ...(this.addresses().find(tailnet) ? { alternate: this.addresses().find(tailnet) } : {}),
              }),
            );
            channel.exit(0);
          } catch {
            channel.exit(1);
          }
          channel.end();
        });
      });
      client.on('tcpip', (accept, reject, info) => {
        let port;
        try {
          port = Number(this.endpoint().port);
        } catch {
          return reject();
        }
        if (!this.authorized(entry.id) || info.destIP !== '127.0.0.1' || info.destPort !== port)
          return reject();
        const socket = connect(port, '127.0.0.1');
        let localPort;
        sockets.add(socket);
        let channel;
        socket.once('connect', () => {
          if (!this.authorized(entry.id) || !this.clients.has(client)) {
            socket.destroy();
            return reject();
          }
          localPort = socket.localPort;
          this.forwardedPorts.add(localPort);
          channel = accept();
          channel.on('error', () => socket.destroy()).on('close', () => socket.destroy());
          channel.pipe(socket).pipe(channel);
        });
        socket.on('error', () => {
          if (channel) channel.destroy();
          else reject();
        });
        socket.on('close', () => {
          this.forwardedPorts.delete(localPort);
          sockets.delete(socket);
          channel?.end();
        });
      });
    });
  }

  // A single-use key for the asking phone to join this computer's mesh: {controlURL, authKey, address} or {error}.
  meshInvite(channel) {
    this.mesh.invite().then((reply) => {
      const out = reply.error ? { error: reply.error } : { controlURL: reply.controlURL, authKey: reply.authKey, address: this.mesh.ip };
      try { channel.write(JSON.stringify(out)); channel.exit(reply.error ? 1 : 0); channel.end(); } catch {}
    });
  }

  // One `pallas-claude` command: the catalog as one JSON object, or a send streamed as JSON lines.
  runClaude(command, channel, entry) {
    const write = (object) => { try { channel.write(JSON.stringify(object) + '\n'); } catch {} };
    const end = (code) => { try { channel.exit(code); channel.end(); } catch {} };
    if (command.verb === 'catalog') {
      try { write(this.claude.catalog()); end(0); } catch (error) { write({ e: 'error', code: 'catalog_failed', message: String(error.message) }); end(1); }
      return;
    }
    const abort = new AbortController();
    const stop = () => abort.abort();
    channel.on('close', stop).on('error', stop);
    // A revoked phone stops following too; the session on this computer keeps working.
    const watchRevoke = setInterval(() => { if (!this.authorized(entry.id)) { stop(); end(1); } }, 5000);
    this.claude.send(command.request, write, abort.signal)
      .then(() => end(0))
      .catch((error) => { write({ e: 'error', code: String(error.message).split(':')[0], message: String(error.message) }); end(1); })
      .finally(() => clearInterval(watchRevoke));
  }

  close() {
    this.closed = true;
    this.claude.close();
    this.mesh.detach(this);
    clearInterval(this.relayTimer);
    for (const server of this.relays.values()) server.close();
    this.relays.clear();
    this.deviceWatcher?.close();
    this.invitation = null;
    for (const entry of this.clients.values()) entry.drop();
    this.server.close();
  }
}
