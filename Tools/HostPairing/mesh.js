import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// The Pallas mesh broker (Tools/PallasMesh). Production URL goes here once the server is up;
// until then PALLAS_MESH_BROKER or a `mesh-broker` file in the pairing directory turns it on.
const DEFAULT_BROKER = '';

/**
 * Puts this computer on the Pallas mesh with `pallas-mesh-node` (userspace Tailscale), so a
 * paired phone can reach the gateway from anywhere. One per process: gateways come and go when
 * the chosen address changes, the node and its loopback hand-off stay.
 */
class Mesh {
  constructor(dir) {
    this.dir = dir;
    this.ip = null;
    this.target = null;
    this.pending = new Map();
    this.seq = 0;
    this.broker = process.env.PALLAS_MESH_BROKER
      || (existsSync(join(dir, 'mesh-broker')) ? readFileSync(join(dir, 'mesh-broker'), 'utf8').trim() : DEFAULT_BROKER);
    this.binary = process.env.PALLAS_MESH_NODE || join(here, 'bin', 'pallas-mesh-node');
  }

  get available() {
    return Boolean(this.broker) && existsSync(this.binary);
  }

  /** Connections from the mesh go to whichever gateway is current. */
  attach(gateway, port) {
    this.target = gateway;
    if (this.started || !this.available) return;
    this.started = true;
    this.relay = createServer((socket) => {
      if (this.target && !this.target.closed) this.target.server.injectSocket(socket);
      else socket.destroy();
    });
    this.relay.on('error', () => {});
    this.relay.listen(0, '127.0.0.1', () => this.spawn(port));
  }

  detach(gateway) {
    if (this.target === gateway) this.target = null;
  }

  spawn(port) {
    const child = spawn(this.binary, [
      '--dir', join(this.dir, 'mesh'),
      '--broker', this.broker,
      '--forward', `127.0.0.1:${this.relay.address().port}`,
      '--port', String(port),
      '--hostname', hostname().replace(/\.local$/, ''),
    ], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.on('error', () => {});
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.event === 'up') this.ip = message.ip;
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    });
    child.on('exit', () => {
      this.ip = null;
      this.child = null;
      for (const resolve of this.pending.values()) resolve({ error: 'mesh node exited' });
      this.pending.clear();
      // Retry after a pause (no network yet, broker down).
      if (!this.stopped) setTimeout(() => this.spawn(port), 30000).unref();
    });
  }

  /** A single-use key for one phone to join this computer's mesh. */
  invite() {
    if (!this.child) return Promise.resolve({ error: this.available ? 'mesh_starting' : 'mesh_unavailable' });
    const id = String(++this.seq);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ error: 'timeout' }); }, 30000);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      this.child.stdin.write(JSON.stringify({ id, op: 'invite' }) + '\n');
    });
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
    this.relay?.close();
  }
}

const meshes = new Map();
export function meshFor(dir) {
  if (!meshes.has(dir)) meshes.set(dir, new Mesh(dir));
  return meshes.get(dir);
}
