export const panelPath = '/dsh-local-pair';

export function panelURL(section, embedded, query = {}) {
  const url = new URL(panelPath + (section ? '/' + section : ''), 'http://localhost');
  if (embedded) url.searchParams.set('embedded', '1');
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.pathname + url.search;
}

export function renderPanel({ online, devices, grants, qr, notice, settings, installerAvailable, installerURL, zh, embedded }) {
  const t = (cn, en) => zh ? cn : en;
  const url = (section, query) => panelURL(section, embedded, query).replaceAll('&', '&amp;');
  const title = t('Pallas iPhone 操控', 'Pallas iPhone Control');
  const messages = {
    saved: t('设置已保存。', 'Settings saved.'),
    settings_invalid: t('设置无效，请重新选择。', 'Choose a valid setting.'),
    settings_failed: t('没能保存设置，请重试。', 'Could not save settings. Try again.'),
    test_ok: t('已在 iPhone 上打开计算器。', 'Calculator opened on the iPhone.'),
    test_failed: t('请先在 iPhone 上点「允许电脑操控」，再测试。', 'Allow computer control on the iPhone, then test again.'),
    installer_failed: t('没能启动安装组件。', 'Could not start the installer.'),
    lan_address_unavailable: t('请先连接局域网或 Tailscale。', 'Connect to a private network or Tailscale.'),
    lan_setup_busy: t('配对正在准备，请稍后再试。', 'Pairing is starting. Try again shortly.'),
    dsh_loopback_required: t('请从这台电脑的 DSH 本地地址打开。', 'Open DSH from its local address on this computer.'),
    lan_setup_failed: t('没能生成配对码，请重试。', 'Could not create a pairing code. Try again.'),
  };
  const message = Object.hasOwn(messages, notice) ? messages[notice] : '';
  const selected = (value, current) => value === current ? ' selected' : '';
  const authorization = id => {
    const phone = grants.find(grant => id.startsWith(grant.id));
    if (!phone) return t('待授权', 'Awaiting authorization');
    return phone.ready ? t('可操控', 'Ready') : t('操控中', 'In use');
  };
  const rows = devices.map(id => `<div class="device">
    <div><span class="device-name">iPhone / iPad</span> <code>${id.slice(0, 16)}</code><span class="state">${authorization(id)}</span></div>
    <div class="actions">
      <form method="post" action="${url('test', { device: id })}"><button${!settings.enabled ? ' disabled' : ''}>${t('测试操控', 'Test control')}</button></form>
      <details><summary>${t('撤销配对', 'Unpair')}</summary>
        <form method="post" action="${url('revoke', { device: id })}"><button class="danger">${t('确认撤销配对', 'Confirm unpair')}</button></form>
      </details>
    </div>
  </div>`).join('');
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
  :root{color-scheme:light dark;--canvas:#f5f7fa;--card:#fff;--line:#dce3ed;--ink:#172b40;--muted:#526578;--accent:#20589b;--on-accent:#fff;--danger:#a52c28;font:15px/1.55 system-ui,sans-serif}
  @media(prefers-color-scheme:dark){:root{--canvas:#141d28;--card:#1d2a3a;--line:#3b4a5c;--ink:#eef4fc;--muted:#b4c1d2;--accent:#aacdfd;--on-accent:#142b48;--danger:#ffaaa6}}
  *{box-sizing:border-box} body{margin:0;background:var(--canvas);color:var(--ink)} body.embedded{background:transparent}
  main{max-width:880px;margin:auto;padding:28px 22px} .embedded main{padding:4px 4px 18px}
  h1,h2,p{margin:0} h1{font-size:clamp(1.55rem,3vw,2.1rem);letter-spacing:-.025em} h2{font-size:1.06rem}
  header,.title-row,.device,.control,.actions{display:flex;align-items:center;gap:12px;justify-content:space-between;flex-wrap:wrap}
  header{margin-bottom:16px} header a{color:var(--accent)}
  .card{margin:12px 0;padding:18px 20px;border:1px solid var(--line);background:var(--card);border-radius:13px}
  .control,.device{min-height:58px;border-bottom:1px solid var(--line);padding:9px 0} .device:last-child{border:0;padding-bottom:0}
  .control label,.device-name{font-weight:600} code,.state{color:var(--muted)} .state{display:block}
  button,select,summary{font:inherit} button,summary{cursor:pointer} button,select{border-radius:7px;border:1px solid var(--line);padding:7px 10px;background:var(--card);color:var(--ink)}
  button:disabled{opacity:.52;cursor:default} button.primary{background:var(--accent);border-color:var(--accent);color:var(--on-accent);font-weight:600}
  button.danger{color:var(--danger)} a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
  .installer{display:block;width:100%;height:620px;border:0}
  .notice,.empty,.pair{margin-top:12px} .notice{border-left:3px solid var(--accent);padding:8px 12px;background:var(--card)}
  input[type=checkbox]{width:19px;height:19px;accent-color:var(--accent)} img{display:block;width:min(280px,100%);height:auto;margin:10px 0} details{padding:5px 2px} details form{margin-top:6px}
  @media(max-width:480px){main{padding:18px 12px}.card{padding:14px}.device>.actions{width:100%;justify-content:flex-start}}
</style><body${embedded ? ' class="embedded"' : ''}><main>
  <header><h1>${title}</h1><a href="${url('')}">${installerURL ? t('返回设备与设置', 'Back to devices and settings') : t('刷新', 'Refresh')}</a></header>
  ${message ? `<p class="notice" role="status">${message}</p>` : ''}
  ${installerURL ? `<iframe class="installer" title="${t('iPhone 操控组件', 'iPhone control runner')}" src="${installerURL}" referrerpolicy="no-referrer" sandbox="allow-forms allow-same-origin"></iframe>` : `<section class="card" aria-labelledby="devices"><div class="title-row"><h2 id="devices">${t('设备', 'Devices')}</h2>
    <form method="post" action="${url('pair')}"><button class="primary"${online ? '' : ' disabled'}>${t('生成配对码', 'Create pairing code')}</button></form></div>
    ${!online ? `<p class="empty">${messages.lan_address_unavailable}</p>` : ''}
    ${qr ? `<div class="pair">${t('用 Pallas Agent 扫码，2 分钟内有效。', 'Scan in Pallas Agent within two minutes.')}<img alt="${t('设备配对码', 'Device pairing code')}" src="${qr}"></div>` : ''}
    ${rows || `<p class="empty">${t('没有已配对的设备', 'No paired devices')}</p>`}
    ${settings.enabled && devices.length && !grants.length ? `<p class="empty">${t('在 iPhone 上打开「设置 → 手机操控 → 允许电脑操控」。', 'On iPhone, open Settings → Phone Control → Allow Computer Control.')}</p>` : ''}
  </section>
  <section class="card" aria-labelledby="control"><form method="post" action="${url('settings')}">
    <div class="title-row"><h2 id="control">${t('操控设置', 'Control settings')}</h2><button type="submit">${t('保存设置', 'Save settings')}</button></div>
    <div class="control"><label for="enabled">${t('允许 DSH 操控 iPhone', 'Allow iPhone control from DSH')}</label><input id="enabled" name="enabled" type="checkbox" value="yes"${settings.enabled ? ' checked' : ''}></div>
    <div class="control"><label for="screenMode">${t('读屏方式', 'Screen input')}</label><select id="screenMode" name="screenMode">
      <option value="auto"${selected('auto', settings.screenMode)}>${t('模型支持时发送截图', 'Screenshot when supported')}</option>
      <option value="text"${selected('text', settings.screenMode)}>${t('仅发送屏幕文字', 'Screen text only')}</option>
    </select></div>
    <div class="control"><label for="preferredDevice">${t('默认设备', 'Default device')}</label><select id="preferredDevice" name="preferredDevice">
      <option value="">${t('仅一台设备时自动选择', 'Choose when only one is available')}</option>
      ${devices.map(id => `<option value="${id}"${selected(id, settings.preferredDevice)}>iPhone / iPad · ${id.slice(0, 16)}</option>`).join('')}
    </select></div>
  </form></section>
  <section class="card" aria-labelledby="installer"><div class="title-row"><h2 id="installer">${t('iPhone 操控组件', 'iPhone control runner')}</h2>
    ${installerAvailable ? `<a href="${url('installer')}">${t('安装与修复', 'Install and repair')}</a>` : ''}</div>
    ${installerAvailable ? '' : `<p class="empty">${t('USB 安装随 macOS 版插件提供。', 'USB installation comes with the macOS plugin package.')}</p>`}
  </section>`}
</main></body></html>`;
}
