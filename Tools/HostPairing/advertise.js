import { spawn as spawnProcess } from 'node:child_process';
import { hostname } from 'node:os';

// Phones on the same network find this computer by Bonjour (DNS-SD) instead of by a typed
// address, and find it again after its address changed. The record names the gateway's port and
// its host key fingerprint; a phone still checks that key when it connects, so a forged record
// leads nowhere. Pairing itself still needs a code from this computer.
export const serviceType = '_pallas-host._tcp';

/** The instance name: this computer's name without `.local`, at most 63 bytes of UTF-8. */
export function instanceName(name = hostname()) {
  let text = String(name).replace(/\.local\.?$/i, '').trim() || 'DSH';
  while (Buffer.byteLength(text) > 63) text = text.slice(0, -1);
  return text;
}

/** The command that publishes the record on this system, or null when it has none. */
export function publisher(platform, { name, port, txt }) {
  const entries = Object.entries(txt).map(([key, value]) => `${key}=${value}`);
  // macOS: mDNSResponder, through the tool every Mac has. It keeps the record while it runs.
  if (platform === 'darwin') return ['/usr/bin/dns-sd', ['-R', name, serviceType, 'local', String(port), ...entries]];
  // Linux with Avahi.
  if (platform === 'linux') return ['avahi-publish-service', [name, serviceType, String(port), ...entries]];
  return null;
}

/**
 * Publishes the gateway until the returned function is called. Restarts the publisher when it
 * exits on its own (mDNSResponder restarted, network change), at most once every 10 seconds.
 */
export function advertise({ port, pin, name = instanceName(), platform = process.platform, spawn = spawnProcess, logger } = {}) {
  const command = publisher(platform, { name, port, txt: { v: '1', pin } });
  if (!command) {
    logger?.info?.('Pallas Agent pairing: no Bonjour publisher on this system');
    return () => {};
  }
  let child;
  let stopped = false;
  let timer;
  const start = () => {
    if (stopped) return;
    const began = Date.now();
    child = spawn(command[0], command[1], { stdio: 'ignore' });
    child.on('error', (error) => {
      // Not installed (avahi on a minimal Linux): nothing to retry.
      if (error.code === 'ENOENT') { stopped = true; logger?.info?.('Pallas Agent pairing: ' + command[0] + ' is not installed'); }
    });
    child.on('exit', () => {
      if (stopped) return;
      timer = setTimeout(start, Math.max(0, 10000 - (Date.now() - began)));
      timer.unref?.();
    });
  };
  start();
  return () => {
    stopped = true;
    clearTimeout(timer);
    child?.kill();
  };
}
