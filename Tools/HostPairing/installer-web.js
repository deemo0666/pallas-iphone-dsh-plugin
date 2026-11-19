import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { renderInstaller } from './installer-panel.js';
import { readForm } from './web-forms.js';

const bundled = fileURLToPath(new URL('./mac/', import.meta.url));
const installCommands = new Set(['install-runner', 'repair-runtime']);
const workerEnv = () => {
  const env = { ...process.env };
  delete env.RUST_LOG;
  delete env.RUST_BACKTRACE;
  return env;
};
const runFile = promisify(execFile);

export function hasInstaller(dir = bundled) {
  return process.platform === 'darwin' && existsSync(join(dir, 'dsh-installer-service'))
    && existsSync(join(dir, 'Kit/ScreenRunner.ipa')) && existsSync(join(dir, 'Kit/RunnerHost.json'))
    && existsSync(join(dir, 'Kit/SHA256SUMS')) && existsSync(join(dir, 'metadata.json'));
}

export function createInstallerWeb(parentOrigin, dir = bundled) {
  const worker = join(dir, 'dsh-installer-service');
  const kit = join(dir, 'Kit');
  if (!hasInstaller(dir) || !/^http:\/\/127\.0\.0\.1:\d+$/.test(parentOrigin)) return null;
  const meta = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8'));
  const accessPath = '/installer/' + randomBytes(32).toString('base64url');
  let job;
  let listening;
  let closed = false;

  async function listDevices() {
    try {
      const { stdout } = await runFile(worker, ['devices'], { cwd: kit, env: workerEnv(), timeout: 15_000, maxBuffer: 192 * 1024 });
      return JSON.parse(stdout);
    } catch { return null; }
  }

  async function start(form, command) {
    if (job?.busy) return 'busy';
    if (!installCommands.has(command)) return 'invalid';
    const device = form.get('device');
    const snapshot = await listDevices();
    if (job?.busy) return 'busy';
    if (!device || !snapshot?.entries?.some(entry => entry.id === device)) return 'device_missing';
    if (closed) return 'invalid';
    const args = command === 'repair-runtime' ? [command, '--device', device] : [command, kit, '--device', device];

    const child = spawn(worker, args, { cwd: kit, env: workerEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const state = { id: randomUUID(), busy: true, child, step: 'checking' };
    job = state;
    child.stdin.on('error', () => { if (state.busy) state.problem = 'input_failed'; });
    child.on('error', () => { state.problem = 'start_failed'; });
    createInterface({ input: child.stdout }).on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      switch (event?.type) {
      case 'progress': state.step = event.step; state.message = ''; state.transfer = undefined; break;
      case 'activity': state.message = event.message; break;
      case 'waiting': state.message = event.message; break;
      case 'transfer': state.message = ''; state.transfer = event; break;
      case 'prompt': state.prompt = event; break;
      case 'runtime_ready': case 'single_installed':
        state.result = event; state.message = ''; break;
      case 'failure': state.problem = 'operation_failed'; state.message = event.message; break;
      }
    });
    child.on('close', code => {
      state.busy = false;
      state.prompt = undefined;
      state.transfer = undefined;
      if (state.stopping) state.problem = 'stopped';
      else if (code !== 0) state.problem ||= 'operation_failed';
      else if (!state.result) state.problem ||= 'operation_failed';
    });
    return '';
  }

  function respond(form) {
    const active = job;
    if (!active?.busy || active.id !== form.get('job')) return 'invalid';
    if (form.get('action') === 'cancel') {
      active.stopping = true;
      const waiting = !!active.prompt;
      active.prompt = undefined;
      active.child.stdin.end();
      if (!waiting) active.child.kill();
      return '';
    }
    const prompt = active.prompt;
    if (!prompt || String(prompt.id) !== form.get('prompt')) return 'invalid';
    let value;
    if (prompt.action === 'login') {
      const email = form.get('email')?.trim(), password = form.get('password');
      if (!email || !password) return 'invalid';
      value = { email, password };
    } else if (prompt.action === 'verification') {
      const code = form.get('code'), method = form.get('method');
      if (method !== 'verify' && /^\d+$/.test(method ?? '') && Number(method) < prompt.choices.length) value = { send: Number(method) };
      else if (typeof code === 'string' && /^\d{6}$/.test(code)) value = { code };
      else return 'invalid';
    } else if (prompt.choices.length) {
      value = form.get('choice');
      if (!prompt.choices.includes(value)) return 'invalid';
    } else value = '';
    active.prompt = undefined;
    active.child.stdin.write(JSON.stringify({ id: prompt.id, value }) + '\n');
    return '';
  }

  const server = createServer(async (req, res) => {
    const port = server.address()?.port;
    if (!port) return res.writeHead(503).end();
    const address = '127.0.0.1:' + port;
    const origin = 'http://' + address;
    if (req.headers.host !== address || req.url.split('?')[0] !== accessPath) return res.writeHead(404).end();
    const url = new URL(req.url, origin);
    const zh = url.searchParams.get('lang') === 'zh';
    const home = accessPath + '?lang=' + (zh ? 'zh' : 'en');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors ${parentOrigin}; base-uri 'none'`);
    try {
      if (req.method === 'POST') {
        if (req.headers.origin !== origin) return res.writeHead(403).end();
        const form = await readForm(req);
        const action = form.get('action');
        const status = action === 'cancel' || action === 'respond' ? respond(form) : await start(form, action);
        return res.writeHead(303, { Location: home + (status ? '&notice=' + status : '') }).end();
      }
      if (req.method !== 'GET') return res.writeHead(405).end();
      const devices = job?.busy ? null : await listDevices();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderInstaller({ meta, devices, job, home, zh, notice: url.searchParams.get('notice') }));
    } catch {
      if (req.method === 'POST') res.writeHead(303, { Location: home + '&notice=invalid' }).end();
      else res.writeHead(500).end();
    }
  });

  return {
    async url(zh) {
      if (!listening) listening = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      await listening;
      if (closed) throw new Error('installer_closed');
      return 'http://127.0.0.1:' + server.address().port + accessPath + (zh ? '?lang=zh' : '?lang=en');
    },
    close() {
      closed = true;
      if (job?.busy) { job.child.stdin.end(); job.child.kill(); }
      server.close();
      server.closeAllConnections();
    },
  };
}
