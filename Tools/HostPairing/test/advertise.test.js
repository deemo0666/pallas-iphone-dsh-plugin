import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { advertise, instanceName, publisher, serviceType } from '../advertise.js';

test('the record carries the port and host key fingerprint on macOS and Linux only', () => {
  const txt = { v: '1', pin: 'abc+/def' };
  assert.deepEqual(publisher('darwin', { name: 'Mac', port: 42484, txt }),
    ['/usr/bin/dns-sd', ['-R', 'Mac', serviceType, 'local', '42484', 'v=1', 'pin=abc+/def']]);
  assert.deepEqual(publisher('linux', { name: 'box', port: 1, txt })[1], ['box', serviceType, '1', 'v=1', 'pin=abc+/def']);
  assert.equal(publisher('win32', { name: 'pc', port: 1, txt }), null);
});

test('instance names drop .local and fit in 63 bytes', () => {
  assert.equal(instanceName('MacBook-Pro.local'), 'MacBook-Pro');
  assert.equal(instanceName(''), 'DSH');
  const long = instanceName('电脑'.repeat(40));
  assert.ok(Buffer.byteLength(long) <= 63 && long.length > 0);
});

test('the publisher restarts after exiting on its own and stops for good when withdrawn', async () => {
  const children = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('exit'); };
    children.push(child);
    return child;
  };
  const withdraw = advertise({ port: 42484, pin: 'p', name: 'Mac', platform: 'darwin', spawn });
  assert.equal(children.length, 1);
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn) => { fn(); return { unref() {} }; };
  try { children[0].emit('exit'); } finally { globalThis.setTimeout = realSetTimeout; }
  assert.equal(children.length, 2);
  withdraw();
  assert.ok(children[1].killed);
  assert.equal(children.length, 2);
});

test('a missing publisher is not retried', () => {
  let spawned = 0;
  const spawn = () => {
    spawned++;
    const child = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => { child.emit('error', Object.assign(new Error('nope'), { code: 'ENOENT' })); child.emit('exit'); });
    return child;
  };
  advertise({ port: 1, pin: 'p', platform: 'linux', spawn });
  return new Promise((resolve) => setImmediate(() => { assert.equal(spawned, 1); resolve(); }));
});
