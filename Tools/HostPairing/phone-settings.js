import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const phoneDefaults = Object.freeze({ enabled: true, screenMode: 'auto', preferredDevice: '' });
export const deviceID = /^[a-f0-9]{64}$/;

export function readPhoneSettings(dir) {
  try {
    const saved = JSON.parse(readFileSync(join(dir, 'phone-settings.json'), 'utf8'));
    return {
      enabled: saved.enabled !== false,
      screenMode: saved.screenMode === 'text' ? 'text' : 'auto',
      preferredDevice: typeof saved.preferredDevice === 'string' && deviceID.test(saved.preferredDevice) ? saved.preferredDevice : '',
    };
  } catch (error) {
    if (error.code === 'ENOENT') return phoneDefaults;
    throw error;
  }
}

export function savePhoneSettings(dir, settings) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, 'phone-settings-' + randomUUID() + '.tmp');
  writeFileSync(temp, JSON.stringify(settings) + '\n', { mode: 0o600, flag: 'wx' });
  try { renameSync(temp, join(dir, 'phone-settings.json')); }
  catch (error) { unlinkSync(temp); throw error; }
}
