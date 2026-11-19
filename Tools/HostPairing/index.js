import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { Gateway, reachableAddresses } from './gateway.js';
import { advertise } from './advertise.js';
import { PhoneControl } from './phone.js';
import { registerPhoneTool } from './phone-tool.js';
import { readPhoneSettings, savePhoneSettings } from './phone-settings.js';
import { panelPath as route, panelURL, renderPanel } from './panel.js';
import { createInstallerWeb, hasInstaller } from './installer-web.js';
import { readForm } from './web-forms.js';

export const name = 'dsh-local-pair';
const defaultPort = 42484;

export function apply(ctx) {
  const dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-local-pair');
  const phoneControl = new PhoneControl(readPhoneSettings(dir));
  const update = settings => {
    savePhoneSettings(dir, settings);
    phoneControl.configure(settings);
  };
  ctx.inject(['tools', 'agents', 'profileContext'], async scope => {
    // Match the running engine's SDK. A profile dependency can shadow the engine's
    // own Tools service and prevent startup when the two versions differ.
    const anchor = scope.profileContext.installAnchor;
    const resolve = createRequire(anchor.startsWith('file:') ? new URL(anchor) : anchor).resolve;
    const { defineTool } = await import(pathToFileURL(resolve('@deepseek-ai/dsh-tools')));
    registerPhoneTool(scope, phoneControl, defineTool);
  });
  ctx.inject(['webServer', 'connection'], (web) =>
    web.effect(() => {
      let installer;
      const settings = join(dir, 'address');
      const portFile = join(dir, 'port');
      const endpoint = () => {
        const origin = web.webServer.getOrigin();
        const url = new URL(web.connection.authenticatedUrl(origin));
        if (
          url.origin !== origin ||
          url.hostname !== '127.0.0.1' ||
          url.protocol !== 'http:' ||
          !url.searchParams.get('token')
        )
          throw new Error('dsh_loopback_required');
        return url;
      };
      const forwardedPorts = new Set();
      let gateway = new Gateway(dir, endpoint, forwardedPorts, undefined, phoneControl);
      let disposed = false;
      let binding = false;
      // Published while a gateway listens, so phones on this network list this computer.
      let withdraw = () => {};
      async function bind(address) {
        if (!reachableAddresses().includes(address)) throw new Error('lan_address_unavailable');
        if (binding) throw new Error('lan_setup_busy');
        if (gateway.server.address()?.address === address) return;
        binding = true;
        const next = new Gateway(dir, endpoint, forwardedPorts, undefined, phoneControl);
        try {
          let preferred = defaultPort;
          try {
            const saved = Number(readFileSync(portFile, 'utf8'));
            if (Number.isInteger(saved) && saved > 0 && saved <= 65535) preferred = saved;
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          try { await next.listen(address, preferred); }
          catch (error) {
            if (error.code !== 'EADDRINUSE') throw error;
            await next.listen(address, 0);
          }
          if (disposed) throw new Error('lan_closed');
          writeFileSync(portFile, String(next.server.address().port), { mode: 0o600 });
          gateway.close();
          gateway = next;
          withdraw();
          withdraw = advertise({ port: next.server.address().port, pin: next.fingerprint, logger: web.logger });
        } catch (error) {
          next.close();
          throw error;
        } finally {
          binding = false;
        }
      }
      try {
        const saved = readFileSync(settings, 'utf8');
        void bind(saved).catch(() => web.logger?.warn?.('Pallas Agent pairing: select a local address to resume'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }

      const unregister = web.webServer.register({
        kind: 'prefix',
        path: route,
        async handler(req, res) {
          const reject = (status, code) =>
            res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(code);
          res.setHeader('Cache-Control', 'no-store');
          // Browsers need a same-origin Origin on form POSTs for DSH's request fence.
          res.setHeader('Referrer-Policy', 'same-origin');
          const denied = web.connection.requestRejection(req);
          if (denied) return reject(denied, 'desktop_auth_required');
          // A paired phone has a valid DSH cookie too. Check the real peer socket,
          // never a request header, before exposing the local owner's controls.
          if (
            req.socket.remoteAddress !== '127.0.0.1' ||
            gateway.forwardedPorts.has(req.socket.remotePort)
          )
            return reject(403, 'desktop_only');
          if (req.method === 'POST' && req.headers.origin !== 'http://' + req.headers.host)
            return reject(403, 'invalid_origin');
          const path = new URL(req.url, 'http://localhost');
          const embedded = path.searchParams.get('embedded') === '1';
          const zh = (req.headers['accept-language'] || '').startsWith('zh');
          const redirect = notice => res.writeHead(303, { Location: panelURL('', embedded, { notice }) }).end();
          let qr = '';
          let notice = path.searchParams.get('notice') ?? '';
          let installerURL;
          try {
            if (req.method === 'GET' && path.pathname === route + '/installer') {
              try {
                installer ??= createInstallerWeb(endpoint().origin);
                installerURL = await installer?.url(zh);
              } catch { return redirect('installer_failed'); }
              if (!installerURL) return redirect('installer_failed');
            } else if (req.method === 'POST' && path.pathname === route + '/pair') {
              endpoint();
              // The address bound before, while this computer still has it; otherwise its first.
              let address = '';
              try { address = readFileSync(settings, 'utf8'); } catch {}
              const online = reachableAddresses();
              if (!online.includes(address)) address = online[0] ?? '';
              await bind(address);
              writeFileSync(settings + '.tmp', address, { mode: 0o600 });
              renameSync(settings + '.tmp', settings);
              qr = await QRCode.toDataURL(gateway.invite(), { width: 340 });
            } else if (req.method === 'POST' && path.pathname === route + '/revoke') {
              const device = path.searchParams.get('device');
              if (!gateway.revoke(device)) return reject(404, 'device_not_found');
              if (phoneControl.settings.preferredDevice === device) update({ ...phoneControl.settings, preferredDevice: '' });
            } else if (req.method === 'POST' && path.pathname === route + '/settings') {
              let form;
              try { form = await readForm(req); } catch { return redirect('settings_invalid'); }
              const screenMode = form.get('screenMode');
              const preferredDevice = form.get('preferredDevice') ?? '';
              if (!['auto', 'text'].includes(screenMode) || (preferredDevice && !gateway.devices().includes(preferredDevice))) return redirect('settings_invalid');
              try { update({ enabled: form.get('enabled') === 'yes', screenMode, preferredDevice }); }
              catch { return redirect('settings_failed'); }
              return redirect('saved');
            } else if (req.method === 'POST' && path.pathname === route + '/test') {
              const device = path.searchParams.get('device');
              if (!gateway.devices().includes(device)) return reject(404, 'device_not_found');
              const abort = new AbortController();
              res.once('close', () => abort.abort());
              const owner = randomUUID();
              let phone;
              try {
                phone = phoneControl.pick(device.slice(0, 16));
                const view = await phoneControl.request(phone, owner, { action: 'open', app: 'com.apple.calculator', picture: false }, abort.signal);
                notice = view.opening || view.searchMissing ? 'test_failed' : 'test_ok';
              } catch { notice = 'test_failed'; }
              finally { if (phone) phoneControl.finish(phone, owner, notice !== 'test_ok'); }
            } else if (req.method !== 'GET' || path.pathname !== route) return reject(404, 'not_found');
          } catch (error) {
            const codes = ['lan_address_unavailable', 'lan_setup_busy', 'dsh_loopback_required'];
            return redirect(codes.includes(error.message) ? error.message : 'lan_setup_failed');
          }
          res.setHeader('Content-Security-Policy', [
            "default-src 'none'", "img-src data:", "style-src 'unsafe-inline'", "form-action 'self'", "base-uri 'none'",
            `frame-ancestors ${embedded ? "'self'" : "'none'"}`,
            ...(installerURL ? [`frame-src ${new URL(installerURL).origin}`] : []),
          ].join('; '));
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(renderPanel({ online: reachableAddresses().length > 0, devices: gateway.devices(), grants: phoneControl.devices(),
            qr, notice, settings: phoneControl.settings, installerAvailable: hasInstaller(), installerURL, zh, embedded }));
        },
      });
      return () => {
        disposed = true;
        unregister();
        withdraw();
        installer?.close();
        phoneControl.close();
        gateway.close();
      };
    }),
  );
}
