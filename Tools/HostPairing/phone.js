import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { phoneDefaults } from './phone-settings.js';

const idleMs = 120_000;
const maxReply = 6 * 1024 * 1024;
const offline = 'On the iPhone, open Pallas Agent → Settings → Phone Control → Allow computer control.';

// An SSH channel is offered by the phone for one turn. Every command uses that
// channel's device key and a single lease; nothing listens for commands on iOS.
export class PhoneControl {
  #phones = new Map();

  constructor(settings = phoneDefaults) {
    this.configure(settings);
  }

  configure(settings) {
    this.settings = settings;
    if (!settings.enabled) this.close();
  }

  devices() {
    return [...this.#phones.values()].filter(phone => phone.authorized()).map(phone => ({
      id: phone.id.slice(0, 16), ready: !phone.owner,
    }));
  }

  pick(id) {
    if (!this.settings.enabled) throw new Error('iPhone control is turned off in DSH plugin settings.');
    const phones = [...this.#phones.values()].filter(phone => phone.authorized());
    id ||= this.settings.preferredDevice;
    if (id) {
      const phone = phones.find(phone => phone.id === id || phone.id.slice(0, 16) === id);
      if (!phone) throw new Error(offline);
      return phone;
    }
    if (!phones.length) throw new Error(offline);
    if (phones.length !== 1) throw new Error('Choose an iPhone by its device ID from the status result.');
    return phones[0];
  }

  attach(id, channel, authorized) {
    const phone = { id, channel, authorized, owner: null, pending: null, ready: false, closed: false };
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    phone.touch = () => {
      clearTimeout(phone.timer);
      phone.timer = setTimeout(() => this.#close(phone, new Error('iPhone authorization expired.')), idleMs);
      phone.timer.unref();
    };
    phone.touch();
    channel.on('error', () => this.#close(phone));
    channel.on('close', () => this.#close(phone));
    channel.on('data', bytes => {
      if (phone.closed || !this.settings.enabled || !authorized()) return this.#close(phone);
      buffer += decoder.write(bytes);
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        if (end > maxReply) return this.#close(phone);
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { return this.#close(phone); }
        if (!reply || typeof reply !== 'object') return this.#close(phone);
        if (!phone.ready) {
          if (reply.type !== 'hello' || reply.version !== 1 || this.#phones.has(id)) return this.#close(phone);
          phone.ready = true;
          this.#phones.set(id, phone);
          this.#send(phone, { type: 'ready', version: 1 });
        } else if (reply.type === 'result' && phone.pending && reply.id === phone.pending.id) {
          const { settle } = phone.pending;
          if (typeof reply.error === 'string') settle(new Error(reply.error));
          else if (typeof reply.value?.screen === 'string' && typeof reply.value.text === 'string') settle(null, reply.value);
          else return this.#close(phone);
        } else return this.#close(phone);
      }
      if (buffer.length > maxReply) this.#close(phone);
    });
  }

  request(phone, owner, command, signal) {
    signal.throwIfAborted();
    if (phone.closed || !phone.authorized()) throw new Error(offline);
    if ((phone.owner && phone.owner !== owner) || phone.pending) throw new Error('iPhone is busy.');
    if (!phone.owner && command.action !== 'open') throw new Error('Open an app first.');
    phone.owner = owner;
    clearTimeout(phone.timer);
    const id = randomUUID();
    const typing = command.action === 'type' ? Math.ceil([...command.text].length / 4) * 1000 : 0;
    return new Promise((resolve, reject) => {
      const abort = () => this.#close(phone, new Error('iPhone control stopped.'), true);
      const timer = setTimeout(() => this.#close(phone, new Error('iPhone did not respond in time.'), true), 180_000 + typing);
      const settle = (error, result) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        phone.pending = null;
        if (!phone.closed) phone.touch();
        if (error) reject(error); else resolve(result);
      };
      phone.pending = { id, settle };
      signal.addEventListener('abort', abort, { once: true });
      this.#send(phone, { type: 'command', id, owner, command });
    });
  }

  finish(phone, owner, cancel = false) {
    if (phone.owner !== owner) return;
    this.#close(phone, new Error('iPhone control stopped.'), cancel || !!phone.pending);
  }

  close() {
    for (const phone of this.#phones.values()) this.#close(phone, undefined, true);
  }

  #send(phone, message) {
    try { phone.channel.write(JSON.stringify(message) + '\n'); }
    catch { this.#close(phone); }
  }

  #close(phone, error = new Error('iPhone disconnected.'), cancel = true) {
    if (phone.closed) return;
    phone.closed = true;
    clearTimeout(phone.timer);
    if (this.#phones.get(phone.id) === phone) this.#phones.delete(phone.id);
    phone.pending?.settle(error);
    if (phone.owner && phone.authorized()) this.#send(phone, { type: 'end', owner: phone.owner, cancel });
    phone.channel.end();
    phone.channel.close();
  }
}
