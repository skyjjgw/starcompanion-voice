// Design controls; no Operit services. SPDX-License-Identifier: MIT
(() => {
  const $ = id => document.getElementById(id);
  const query = new URLSearchParams(location.search);
  const stateNames = new Set([...document.querySelectorAll('[data-state]')].map(button => button.dataset.state));
  let state = stateNames.has(query.get('state')) ? query.get('state') : 'ready';
  if (['林澈', '许知夏'].includes(query.get('role'))) $('role').value = query.get('role');
  if (query.get('viewport') === 'dialog') $('viewport').value = 'dialog';
  function fit() {
    const dialog = $('viewport').value === 'dialog';
    const width = innerWidth <= 700 ? Math.min(dialog ? 338 : 390, innerWidth - 26) : dialog ? 338 : 390;
    const height = dialog ? 473 : 820;
    const scale = innerWidth <= 700 ? 1 : Math.max(0.5, Math.min(1, (innerHeight - 120) / height, (innerWidth - 350) / width));
    $('device').style.width = `${width}px`; $('device').style.height = `${height}px`;
    $('device').style.transform = `scale(${scale})`;
    $('device-holder').style.width = `${width * scale}px`; $('device-holder').style.height = `${height * scale}px`;
  }
  function update() {
    $('device').classList.toggle('dialog', $('viewport').value === 'dialog');
    fit();
    for (const button of document.querySelectorAll('[data-state]')) button.setAttribute('aria-pressed', String(button.dataset.state === state));
    const params = new URLSearchParams({ state, role: $('role').value, viewport: $('viewport').value });
    history.replaceState(null, '', `/?${params}`);
    $('phone').contentWindow.postMessage({ type: 'starcompanion.preview', state, role: $('role').value }, location.origin);
  }
  $('phone').addEventListener('load', update);
  $('states').addEventListener('click', event => { const button = event.target.closest('[data-state]'); if (button) { state = button.dataset.state; update(); } });
  $('role').addEventListener('change', update); $('viewport').addEventListener('change', update);
  window.addEventListener('resize', fit);
  $('hangup').addEventListener('click', () => { state = 'ended'; update(); });
  $('reset').addEventListener('click', () => { state = 'ready'; $('phone').src = '/phone'; update(); });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== $('phone').contentWindow) return;
    if (event.data?.type === 'starcompanion.preview.ready') update();
    if (event.data?.type === 'starcompanion.preview.state' && stateNames.has(event.data.state)) {
      state = event.data.state;
      for (const button of document.querySelectorAll('[data-state]')) button.setAttribute('aria-pressed', String(button.dataset.state === state));
    }
  });
  let revision, checking = false;
  async function check() {
    if (checking) return; checking = true;
    try {
      const response = await fetch('/version', { cache: 'no-store' });
      if (!response.ok) throw new Error();
      const next = (await response.json()).revision;
      if (revision && next !== revision && $('auto').checked) { location.reload(); return; }
      revision = next;
      $('reload-status').textContent = $('auto').checked ? '预览已连接 · 修改界面后自动刷新' : '自动刷新已暂停';
    } catch { $('reload-status').textContent = '预览服务未连接，启动 npm run preview 后刷新即可。'; }
    finally { checking = false; }
  }
  update(); void check(); setInterval(check, 900);
})();
