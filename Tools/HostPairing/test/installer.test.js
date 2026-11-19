import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { createInstallerWeb } from '../installer-web.js';

test('embedded installer installs only the runner and answers the native prompt over stdin', { skip: process.platform !== 'darwin', timeout: 6000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'pallas-installer-test-'));
  mkdirSync(join(dir, 'Kit'));
  writeFileSync(join(dir, 'Kit/SHA256SUMS'), '');
  writeFileSync(join(dir, 'Kit/ScreenRunner.ipa'), '');
  writeFileSync(join(dir, 'Kit/RunnerHost.json'), '{}');
  writeFileSync(join(dir, 'metadata.json'), JSON.stringify({ version: '1.0', build: '1' }));
  writeFileSync(join(dir, 'dsh-installer-service'), `#!${process.execPath}
const assert = require('node:assert/strict');
const { realpathSync } = require('node:fs');
const read = require('node:readline');
const emit = value => console.log(JSON.stringify(value));
const args = process.argv.slice(2);
if (args[0] === 'devices') emit({type:'devices',entries:[{id:'fixture-phone',name:'Test <iPhone>',version:'27'}]});
else {
  assert.equal(args[0], 'install-runner');
  assert.equal(realpathSync(args[1]), process.cwd());
  assert.deepEqual(args.slice(2), ['--device', 'fixture-phone']);
  emit({type:'prompt',id:1,action:'login',message:'Sign in',choices:[]});
  read.createInterface({input:process.stdin}).once('line', line => {
    assert.deepEqual(JSON.parse(line), {id:1,value:{email:'fixture@example.invalid',password:'test-only'}});
    emit({type:'single_installed',component:'runner',expires:'2030-01-01'});
    process.exit(0);
  });
}
`, { mode: 0o700 });
  const installer = createInstallerWeb('http://127.0.0.1:3000', dir);
  t.after(() => { installer.close(); rmSync(dir, { recursive: true, force: true }); });
  const url = new URL(await installer.url(true));
  const post = (fields, origin = url.origin) => fetch(url, {
    method: 'POST', redirect: 'manual', headers: { Origin: origin }, body: new URLSearchParams(fields),
  });
  assert.equal((await fetch(new URL('/installer/invalid', url))).status, 404);
  const first = await fetch(url);
  assert.match(first.headers.get('content-security-policy'), /frame-ancestors http:\/\/127\.0\.0\.1:3000/);
  const html = await first.text();
  assert.match(html, /Test &lt;iPhone&gt;/);
  assert.match(html, /value="install-runner"/);
  assert.doesNotMatch(html, /全部安装|安装主 App|自动续签/);
  assert.equal((await post({ action: 'install-runner' }, 'http://127.0.0.1:4000')).status, 403);
  for (const action of ['install', 'install-host', 'renew-now']) {
    assert.match((await post({ action, device: 'fixture-phone' })).headers.get('location'), /invalid/);
  }
  assert.match((await post({ action: 'install-runner', device: 'other' })).headers.get('location'), /device_missing/);
  assert.equal((await post({ action: 'install-runner', device: 'fixture-phone' })).status, 303);
  let page = '';
  while (!page.includes('name="prompt"')) { await pause(20); page = await (await fetch(url)).text(); }
  const job = page.match(/name="job" value="([0-9a-f-]+)"/)[1];
  assert.match((await post({ action: 'respond', job, prompt: '2' })).headers.get('location'), /invalid/);
  await post({ action: 'respond', job, prompt: '1', email: 'fixture@example.invalid', password: 'test-only' });
  while (!page.includes('操控组件已安装')) { await pause(20); page = await (await fetch(url)).text(); }
  assert.match(page, /2030-01-01/);
  assert.doesNotMatch(page, /test-only|fixture@example/);
});
