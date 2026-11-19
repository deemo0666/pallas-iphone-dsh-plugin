import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { defineTool } from '@deepseek-ai/dsh-tools';
import ssh2 from 'ssh2';
import { Gateway, generateSSHKey } from '../gateway.js';
import { PhoneControl } from '../phone.js';
import { registerPhoneTool } from '../phone-tool.js';

test('the DSH tool accepts the latest screen and relinquishes control at the end of its turn', async () => {
  const handlers = new Map();
  const agent = { session: { id: 'session', requestHeader() {} }, options: {} };
  const phone = { id: 'device' };
  const calls = [];
  let tool;
  registerPhoneTool({
    on: (event, handle) => handlers.set(event, handle),
    get() {},
    agents: { turnBoundaryOf: () => ({ openTurnStartSeq: 0, lastTurn: 1 }) },
    tools: { register: definition => { tool = definition; } },
  }, {
    settings: { enabled: true, screenMode: 'auto' },
    pick: () => phone,
    request(target, owner, command) {
      assert.equal(target, phone);
      calls.push([owner, command.action]);
      return { screen: 'latest', text: 'Calculator' };
    },
    finish(target, owner, cancel) {
      assert.equal(target, phone);
      calls.push([owner, 'finish', cancel]);
    },
  }, defineTool);
  const exec = { agent, signal: new AbortController().signal };
  assert.match((await tool.execute({ action: 'open', app: 'com.apple.calculator' }, exec)).text, /Screen latest/);
  const tap = { action: 'tap', x: 250, y: 500 };
  await assert.rejects(tool.execute({ ...tap, screen: 'old' }, exec), /Screen changed/);
  await assert.rejects(tool.execute({ ...tap, x: 1001, screen: 'latest' }, exec), /Coordinates/);
  await tool.execute({ ...tap, screen: 'latest' }, exec);
  handlers.get('session/event')(agent.session, { type: 'turn/end', data: { turn: 1 } });
  const [owner] = calls[0];
  assert.deepEqual(calls, [[owner, 'open'], [owner, 'tap'], [owner, 'finish', false]]);
});

test('iPhone grants one turn over a paired SSH channel and revocation cancels in-flight work', { timeout: 5000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'pallas-phone-'));
  const control = new PhoneControl();
  const gateway = new Gateway(dir, () => new URL('http://127.0.0.1:4321/?token=test'), new Set(), () => [], control);
  await gateway.listen('127.0.0.1', 0);
  const client = new ssh2.Client();
  t.after(() => {
    control.close();
    client.end();
    gateway.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const invite = new URLSearchParams(new URL(gateway.invite()).hash.slice(1)).get('invite');
  const connected = once(client, 'ready');
  client.connect({ host: '127.0.0.1', port: gateway.server.address().port, username: 'pair-' + invite,
    privateKey: generateSSHKey() });
  await connected;
  const [deviceId] = gateway.devices();
  assert.throws(() => control.pick(), /Allow computer control/);

  const grant = async () => {
    const channel = await new Promise((resolve, reject) => client.exec('dsh-local-iphone', (err, stream) => err ? reject(err) : resolve(stream)));
    const lines = createInterface({ input: channel })[Symbol.asyncIterator]();
    const read = async () => JSON.parse((await lines.next()).value);
    assert.deepEqual(control.devices(), []);
    channel.write('{"type":"hel');
    channel.write('lo","version":1}\n');
    assert.deepEqual(await read(), { type: 'ready', version: 1 });
    return { read, channel };
  };

  const first = await grant();
  const phone = control.pick();
  const owner = randomUUID();
  const open = { action: 'open', app: 'com.apple.calculator', picture: false };
  const signal = new AbortController().signal;
  assert.throws(() => control.request(phone, owner, { action: 'observe' }, signal), /Open an app first/);
  const result = control.request(phone, owner, open, signal);
  const command = await first.read();
  assert.deepEqual(command, { type: 'command', id: command.id, owner, command: open });
  assert.throws(() => control.request(phone, randomUUID(), open, signal), /busy/);
  assert.deepEqual(control.devices(), [{ id: deviceId.slice(0, 16), ready: false }]);
  const view = { screen: 'screen-1', text: '计算器' };
  first.channel.write(JSON.stringify({ type: 'result', id: command.id, value: view }) + '\n');
  assert.deepEqual(await result, view);
  control.finish(phone, owner);
  assert.deepEqual(await first.read(), { type: 'end', owner, cancel: false });
  assert.deepEqual(control.devices(), []);

  const second = await grant();
  const abort = new AbortController();
  const pending = control.request(control.pick(), owner, open, abort.signal);
  await second.read();
  const aborted = assert.rejects(pending, /stopped/);
  abort.abort();
  await aborted;
  assert.deepEqual(await second.read(), { type: 'end', owner, cancel: true });

  const third = await grant();
  const revoked = assert.rejects(control.request(control.pick(), owner, open, signal), /disconnected/);
  await third.read();
  assert.equal(gateway.revoke(deviceId), true);
  await revoked;
  assert.deepEqual(control.devices(), []);
});
