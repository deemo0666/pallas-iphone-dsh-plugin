const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function renderInstaller({ meta, devices, job, home, zh, notice }) {
  const t = (cn, en) => zh ? cn : en;
  const stages = {
    checking: t('校验安装包', 'Checking the installer'), device: t('连接设备', 'Connecting the device'),
    account: t('登录 Apple 账号', 'Signing in to Apple'), signing: t('签名', 'Signing'),
    installing: t('安装到设备', 'Installing on the device'), opening: t('确认安装结果', 'Checking the installation'),
  };
  const results = {
    single_installed: t('操控组件已安装', 'Phone control installed'),
    runtime_ready: t('手机操控运行环境已准备', 'Phone control runtime prepared'),
  };
  const problems = {
    invalid: t('请检查所填内容后再试。', 'Check your entries and try again.'),
    busy: t('安装器正在处理另一项操作。', 'The installer is busy.'),
    device_missing: t('选中的 USB 设备已断开。', 'The selected USB device disconnected.'),
    start_failed: t('没能启动安装服务。', 'Could not start the installer.'),
    input_failed: t('安装进程已结束。', 'The installer process ended.'),
    operation_failed: t('操作未完成。', 'The operation did not finish.'),
    stopped: t('已停止。', 'Stopped.'),
  };
  const message = reason => Object.hasOwn(problems, reason) ? problems[reason] : '';
  const form = (contents, extra = '') => `<form method="post" action="${escape(home)}" ${extra}>${contents}</form>`;
  const hidden = (name, value) => `<input type="hidden" name="${name}" value="${escape(value)}">`;
  const button = (action, label, style = '') => `<button class="${style}" name="action" value="${action}">${label}</button>`;
  const prompt = job?.prompt;
  let answer = '';
  if (prompt?.action === 'login') {
    answer = `<label>${t('Apple 账号邮箱或手机号', 'Apple Account email or phone number')}<input name="email" required autocomplete="username" /></label>
      <label>${t('Apple 账号密码', 'Apple Account password')}<input name="password" type="password" required autocomplete="off" /></label>
      <button class="primary">${t('登录并继续', 'Sign in and continue')}</button>`;
  } else if (prompt?.action === 'verification') {
    answer = `<label>${t('六位验证码', 'Six-digit verification code')}<input name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" /></label>
      <div class="actions"><button class="primary" name="method" value="verify">${t('验证并继续', 'Verify and continue')}</button>
      ${prompt.choices.map((choice, index) => `<button name="method" value="${index}">${escape(choice)}</button>`).join('')}</div>`;
  } else if (prompt) {
    answer = `${prompt.choices.length ? `<select name="choice" aria-label="${t('选择', 'Choose')}">${prompt.choices.map(choice => `<option>${escape(choice)}</option>`).join('')}</select>` : ''}
      <button class="primary">${t('继续', 'Continue')}</button>`;
  }
  const progress = job ? `<section class="card" aria-live="polite"><h2>${escape(job.busy ? stages[job.step] ?? stages.checking
    : message(job.problem) || results[job.result?.type] || t('操作完成', 'Operation finished'))}</h2>
    ${job.message ? `<p>${escape(job.message)}</p>` : ''}
    ${job.transfer && job.busy ? `<progress max="100" value="${Number(job.transfer.percent) || 0}"></progress>` : ''}
    ${job.result?.expires ? `<p>${t('签名有效至', 'Signed until')} ${escape(job.result.expires)}</p>` : ''}
    ${prompt ? `<p>${escape(prompt.message)}</p>` + form(hidden('action', 'respond') + hidden('job', job.id) + hidden('prompt', prompt.id) + answer, 'class="prompt"') : ''}
    ${job.busy ? form(hidden('job', job.id) + button('cancel', t('停止', 'Stop'))) : ''}
  </section>` : '';
  const usb = (devices?.entries ?? []).filter(entry => entry.id);
  const connected = `<section class="card"><h2>${t('USB 安装', 'USB installation')}</h2>
    ${usb.length ? form(`<label>${t('目标设备', 'Target device')}<select name="device" required><option value=""${usb.length > 1 ? ' selected' : ''}>${t('选择设备', 'Choose a device')}</option>
      ${usb.map(device => `<option value="${escape(device.id)}"${usb.length === 1 ? ' selected' : ''}>${escape(device.name || 'iPhone')} · ${escape(device.version)} · ${escape(device.id.slice(-6))}</option>`).join('')}</select></label>
      <div class="actions">${button('install-runner', t('安装操控组件', 'Install phone control'), 'primary')}
      ${button('repair-runtime', t('修复操控环境', 'Repair control runtime'))}</div>`, 'class="prompt"')
      : `<p>${devices?.type === 'devices' ? t('连接并解锁 iPhone 或 iPad。', 'Connect and unlock your iPhone or iPad.')
        : t('没能读取 USB 设备。请刷新重试。', 'Could not list USB devices. Refresh to try again.')}</p>`}
  </section>`;
  return `<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
${job?.busy && !prompt ? '<meta http-equiv="refresh" content="2">' : ''}<title>${t('iPhone 操控组件', 'iPhone control runner')}</title>
<style>
  :root{color-scheme:light dark;--card:#fff;--line:#dce3ed;--ink:#172b40;--accent:#20589b;--on-accent:#fff;font:15px/1.55 system-ui,sans-serif}
  @media(prefers-color-scheme:dark){:root{--card:#1d2a3a;--line:#3b4a5c;--ink:#eef4fc;--accent:#aacdfd;--on-accent:#142b48}}
  *{box-sizing:border-box}body{margin:0;color:var(--ink);background:transparent}main{padding:0 1px 8px}
  header,.actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}header{justify-content:space-between}
  h1,h2,p{margin:0}h1{font-size:1.24rem}h2{font-size:1rem}p,progress{margin-top:8px}a{color:var(--accent)}
  .card{background:var(--card);border:1px solid var(--line);border-radius:11px;padding:15px;margin-top:10px}
  button,select,input{font:inherit}button{cursor:pointer}button,select,input{border:1px solid var(--line);border-radius:7px;padding:7px 10px;background:var(--card);color:var(--ink)}
  button.primary{background:var(--accent);color:var(--on-accent);border-color:var(--accent);font-weight:600}
  label{display:grid;gap:4px;font-weight:600}.prompt{display:grid;gap:10px;margin-top:10px;justify-items:start}progress{accent-color:var(--accent)}
</style><main><header><h1>${t('iPhone 操控组件', 'iPhone control runner')} ${escape(meta.version)}${meta.build ? ' (' + escape(meta.build) + ')' : ''}</h1><a href="${escape(home)}">${t('刷新', 'Refresh')}</a></header>
${message(notice) ? `<p role="status">${message(notice)}</p>` : ''}${progress}
${job?.busy ? '' : connected}
</main></html>`;
}
