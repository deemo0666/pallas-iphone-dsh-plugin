import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopSessions, liveSessions, parseCommand, translate } from '../claude-desktop.js';

test('parses only the two bridge commands', () => {
  const payload = Buffer.from(JSON.stringify({ message: 'hi', action: 'continue', sessionId: 'local_a' })).toString('base64url');
  assert.deepEqual(parseCommand('pallas-claude catalog'), { verb: 'catalog' });
  assert.deepEqual(parseCommand('pallas-claude send ' + payload).request.sessionId, 'local_a');
  assert.equal(parseCommand("sh -lc 'dsh-local-endpoint'"), null);
  assert.equal(parseCommand('pallas-claude catalog extra'), null);
  assert.equal(parseCommand('pallas-claude send not+base64'), null);
  assert.equal(parseCommand('pallas-claude rm -rf'), null);
  assert.equal(parseCommand('pallas-claude send ' + payload + ' ; ls'), null);
});

test('follows one turn: starts at the marker, ends at the closing row after the last answer', () => {
  const state = { marker: '[Pallas 1234]', started: false, open: new Set(), ended: false, endSeen: false };
  const rows = [
    { type: 'user', message: { content: 'an earlier turn' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'not ours' }], stop_reason: 'end_turn' } },
    { type: 'user', message: { content: '<cross-session-message>[Pallas 1234] From Pallas on the user\'s iPhone:\nhi</cross-session-message>' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls', description: 'List files' } }], stop_reason: 'tool_use' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false }] } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }], stop_reason: 'end_turn' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } },
    { type: 'system', subtype: 'stop_hook_summary' },
  ];
  const events = rows.flatMap((row) => translate(row, state));
  assert.deepEqual(events.map((e) => e.e), ['received', 'tool', 'tool_done', 'text', 'end']);
  assert.equal(events.find((e) => e.e === 'tool').summary, 'List files');
  assert.equal(events.at(-1).reply, 'done');
});

test('reads desktop sessions and live processes, skipping archived and dead ones', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-desktop-'));
  const dir = join(root, 'account', 'org');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'local_a.json'), JSON.stringify({ sessionId: 'local_a', cliSessionId: 'a', cwd: '/x', title: 'A', lastActivityAt: 2, postTurnSummary: { status_category: 'completed', status_detail: 'did a' } }));
  writeFileSync(join(dir, 'local_b.json'), JSON.stringify({ sessionId: 'local_b', cliSessionId: 'b', cwd: '/y', title: 'B', lastActivityAt: 3, isArchived: true }));
  writeFileSync(join(dir, 'local_c.json'), JSON.stringify({ sessionId: 'local_c', cliSessionId: 'c', cwd: '/z', title: 'C', lastActivityAt: 1 }));
  writeFileSync(join(dir, 'local_bad.json'), JSON.stringify({ sessionId: 'local_bad', cliSessionId: '../outside', cwd: '/z', title: 'Bad' }));
  const sessions = desktopSessions(root);
  assert.deepEqual(sessions.map((s) => s.id), ['local_a', 'local_c']);
  assert.equal(sessions[0].summary.detail, 'did a');

  const registry = join(root, 'sessions');
  mkdirSync(registry);
  writeFileSync(join(registry, `${process.pid}.json`), JSON.stringify({ pid: process.pid, hostSessionId: 'local_a', messagingSocketPath: '/tmp/cc-socks/1.sock', status: 'busy' }));
  writeFileSync(join(registry, '999999.json'), JSON.stringify({ pid: 999999, hostSessionId: 'local_c', messagingSocketPath: '/tmp/cc-socks/2.sock', status: 'idle' }));
  const live = liveSessions(registry);
  assert.equal(live.get('local_a').status, 'busy');
  assert.equal(live.has('local_c'), false);
});

test('over the pairing SSH: a paired device gets the catalog, other commands stay refused', async (t) => {
  const { once } = await import('node:events');
  const { rmSync } = await import('node:fs');
  const ssh2 = (await import('ssh2')).default;
  const { Gateway, generateSSHKey } = await import('../gateway.js');
  const dir = mkdtempSync(join(tmpdir(), 'pair-claude-'));
  const gateway = new Gateway(dir, () => new URL('http://127.0.0.1:4321/?token=test'));
  await gateway.listen('127.0.0.1', 0);
  const client = new ssh2.Client();
  t.after(() => { client.end(); gateway.close(); rmSync(dir, { recursive: true }); });
  const invite = new URLSearchParams(new URL(gateway.invite()).hash.slice(1)).get('invite');
  const ready = once(client, 'ready');
  client.connect({ host: '127.0.0.1', port: gateway.server.address().port, username: 'pair-' + invite, privateKey: generateSSHKey() });
  await ready;
  const run = (command) => new Promise((resolve, reject) => client.exec(command, (error, stream) => {
    if (error) return reject(error);
    let out = '';
    stream.on('data', (d) => { out += d; }).on('close', (code) => resolve({ code, out }));
  }));
  const listed = await run('pallas-claude catalog');
  assert.equal(listed.code, 0);
  assert.ok(Array.isArray(JSON.parse(listed.out).sessions));
  await assert.rejects(run('ls /'));
  const bad = await run('pallas-claude send ' + Buffer.from(JSON.stringify({ message: 'x', action: 'continue', sessionId: 'local_missing' })).toString('base64url'));
  assert.equal(bad.code, 1);
  assert.equal(JSON.parse(bad.out.trim().split('\n').at(-1)).code, 'session_not_found');
});

test('a busy session: the message joins its turn as a queued command and the SendMessage back is the reply', () => {
  const state = { marker: '[Pallas abcd]', started: false, open: new Set(), ended: false, endSeen: false };
  const prompt = '<cross-session-message from="uds:/tmp/cc-socks/42.sock" from-name="Pallas" from-mode="prompting">\n[Pallas abcd] From Pallas on the user\'s iPhone:\nstatus?\n</cross-session-message>';
  const rows = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w1', name: 'Bash', input: { command: 'make' } }], stop_reason: 'tool_use' } },
    { type: 'attachment', attachment: { type: 'queued_command', prompt } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'w1' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 's1', name: 'SendMessage', input: { to: 'uds:/tmp/cc-socks/42.sock', message: 'Half done.' } }], stop_reason: 'tool_use' } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 's1' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'w2', name: 'Write', input: { file_path: '/x' } }], stop_reason: 'tool_use' } },
  ];
  const events = [];
  for (const row of rows) { if (state.ended) break; events.push(...translate(row, state)); }
  assert.equal(events[0].e, 'received');
  assert.equal(events[0].queued, true);
  assert.equal(events.at(-1).e, 'end');
  assert.equal(events.at(-1).reply, 'Half done.');
  assert.ok(!events.some((e) => e.id === 'w2'));
});
