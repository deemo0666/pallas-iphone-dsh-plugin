import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import ssh2 from 'ssh2';
import { Gateway, generateSSHKey } from '../gateway.js';

test('signed devices reconnect after host restart, revoke drops only their streams and denies future logins', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'lan-'));
  const upstream = createServer((socket) => socket.on('error', () => {}).pipe(socket));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const endpoint = () => new URL('http://127.0.0.1:' + upstream.address().port + '/?token=test');
  let gateway = new Gateway(dir, endpoint);
  await gateway.listen('127.0.0.1', 0);
  const clients = [];
  t.after(() => {
    for (const c of clients) c.end();
    gateway.close();
    upstream.close();
    rmSync(dir, { recursive: true });
  });
  const auth = async (username, privateKey) => {
    const client = new ssh2.Client();
    clients.push(client);
    const ready = once(client, 'ready');
    client.connect({ host: '127.0.0.1', port: gateway.server.address().port, username, privateKey });
    await ready;
    return client;
  };
  const code = () =>
    'pair-' + new URLSearchParams(new URL(gateway.invite()).hash.slice(1)).get('invite');
  const phone = generateSSHKey();
  const other = generateSSHKey();
  const first = code();
  const expired = code();
  gateway.invitation.expires = Date.now() - 1;
  await assert.rejects(auth(expired, phone), /authentication/i);
  const valid = code();
  await assert.rejects(auth(first, phone), /authentication/i);
  (await auth(valid, phone)).end();
  await assert.rejects(auth(valid, other), /authentication/i);
  const [id] = gateway.devices();
  const user = 'device-' + id.slice(0, 16);
  const pin = gateway.fingerprint;
  gateway.close();
  gateway = new Gateway(dir, endpoint);
  await gateway.listen('127.0.0.1', 0);
  assert.equal(gateway.fingerprint, pin);
  const live = await auth(user, phone);
  const forward = (port) =>
    new Promise((resolve, reject) =>
      live.forwardOut('127.0.0.1', 1, '127.0.0.1', port, (error, stream) =>
        error ? reject(error) : resolve(stream),
      ),
    );
  await assert.rejects(forward(1));
  const stream = await forward(upstream.address().port);
  stream.write('online');
  assert.equal((await once(stream, 'data'))[0].toString(), 'online');
  (await auth(code(), other)).end();
  const disconnected = once(live, 'close');
  assert.equal(gateway.revoke(id), true);
  await disconnected;
  await assert.rejects(auth(user, phone), /authentication/i);
  const [remaining] = gateway.devices();
  (await auth('device-' + remaining.slice(0, 16), other)).end();
});

test('a paired device reads the endpoint by its own command and learns the tailnet address', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-'));
  const endpoint = () => new URL('http://127.0.0.1:4321/?token=test');
  const gateway = new Gateway(dir, endpoint);
  await gateway.listen('127.0.0.1', 0);
  const client = new ssh2.Client();
  t.after(() => {
    client.end();
    gateway.close();
    rmSync(dir, { recursive: true });
  });
  const link = new URL(gateway.invite());
  assert.equal(link.protocol, 'dshlocal:');
  const invite = new URLSearchParams(link.hash.slice(1));
  const ready = once(client, 'ready');
  client.connect({
    host: '127.0.0.1',
    port: gateway.server.address().port,
    username: 'pair-' + invite.get('invite'),
    privateKey: generateSSHKey(),
  });
  await ready;
  const run = (command) =>
    new Promise((resolve, reject) =>
      client.exec(command, (error, stream) => {
        if (error) return reject(error);
        let out = '';
        stream.on('data', (chunk) => (out += chunk)).on('close', () => resolve(out));
      }),
    );
  const reply = JSON.parse(await run("sh -lc 'dsh-local-endpoint'"));
  assert.equal(reply.port, 4321);
  assert.equal(reply.token, 'test');
  assert.deepEqual(reply.addresses, gateway.addresses());
  assert.equal(reply.addresses[0], '127.0.0.1');
  // Present only while this computer is on a tailnet and that listener is up.
  assert.equal(reply.alternate, gateway.addresses().find((a) => a.startsWith('100.')));
  await assert.rejects(run('sh -lc id'));
});

test('the code lists every address the server answers on, and each one pairs', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-'));
  const endpoint = () => new URL('http://127.0.0.1:4321/?token=test');
  const gateway = new Gateway(dir, endpoint, new Set(), () => ['127.0.0.1', '::1']);
  await gateway.listen('127.0.0.1', 0);
  const client = new ssh2.Client();
  t.after(() => {
    client.end();
    gateway.close();
    rmSync(dir, { recursive: true });
  });
  assert.deepEqual(gateway.addresses(), ['127.0.0.1', '::1']);
  const invite = new URLSearchParams(new URL(gateway.invite()).hash.slice(1));
  assert.equal(invite.get('host'), '127.0.0.1');
  assert.equal(invite.get('alt'), '::1');
  // The other address reaches the same server: the invite pairs there.
  const ready = once(client, 'ready');
  client.connect({
    host: '::1',
    port: gateway.server.address().port,
    username: 'pair-' + invite.get('invite'),
    privateKey: generateSSHKey(),
  });
  await ready;
  assert.equal(gateway.devices().length, 1);
});
