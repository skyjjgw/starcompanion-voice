// Visual simulation only; never captures or synthesizes audio. SPDX-License-Identifier: MIT
(() => {
  const $ = id => document.getElementById(id);
  let role = '林澈', state = 'ready', timer, wave;
  const text = { ready: '准备好后，开始通话', listening: '正在聆听', thinking: '正在回复…', speaking: '正在说话 · 可直接打断', muted: '麦克风已静音', error: '连接暂时中断', ended: '通话已结束' };
  const reply = () => role === '林澈' ? '我在。慢慢说，今天有什么想和我分享的吗？' : '听着呢。要不要先告诉我，今天最开心的一件小事？';
  const post = type => parent.postMessage({ type, state }, location.origin);
  function show(next, notify = true) {
    clearTimeout(timer); clearInterval(wave); state = next;
    $('title').textContent = role; $('title').title = role; $('avatar').textContent = [...role][0];
    $('status').textContent = text[state]; $('timer').textContent = ['ready', 'error', 'ended'].includes(state) ? '设计预览' : '00:28';
    $('configuration').hidden = state !== 'ready'; $('notice').textContent = state === 'error' ? '网络好像断开了，稍后可以重新连接。' : '';
    $('mute').disabled = ['ready', 'ended', 'error'].includes(state); $('mute').setAttribute('aria-pressed', String(state === 'muted'));
    $('mute').querySelector('small').textContent = state === 'muted' ? '取消静音' : '静音';
    $('start').disabled = !['ready', 'ended', 'error'].includes(state); $('start').querySelector('small').textContent = ['ready', 'ended', 'error'].includes(state) ? '开始通话' : '通话中';
    $('keyboard').disabled = false; $('text-send').disabled = false;
    if (state === 'ready') { $('text-form').hidden = true; $('user-caption').textContent = '开始后，说完一句会自动发送。'; $('reply-caption').textContent = '可以随时说话打断播放。'; }
    if (['thinking', 'speaking'].includes(state) && (!$('user-caption').textContent || $('user-caption').textContent.startsWith('开始后'))) $('user-caption').textContent = '你今天过得怎么样？';
    if (state === 'thinking') $('reply-caption').textContent = '';
    if (state === 'speaking') $('reply-caption').textContent = reply();
    for (const bar of $('wave').children) bar.style.height = '7px';
    if (['listening', 'speaking'].includes(state)) {
      let phase = 0;
      wave = setInterval(() => { phase += 0.3; [...$('wave').children].forEach((bar, i) => { bar.style.height = `${8 + Math.abs(Math.sin(phase + i * 0.8)) * 23}px`; }); }, 100);
    }
    if (notify) post('starcompanion.preview.state');
  }
  // The production page's bootstrap uses its normal bridge shape, with sample metadata.
  window.StarVoice = { async request([payload]) {
    if (payload.op === 'bootstrap') return { ok: true, value: { chat: { id: 'design-preview', title: role }, currentChatId: 'design-preview', chats: [], ttsConfigs: [{ id: 'design-voice', name: '温和声音（模拟）' }], ttsError: null } };
    if (payload.op === 'close' || payload.op === 'cancel') return { ok: true, value: {} };
    return { ok: false, error: { code: 'DESIGN_ONLY', message: '这里是界面设计预览，使用模拟对话。' } };
  } };
  window.addEventListener('message', event => {
    if (event.origin !== location.origin || event.source !== parent || event.data?.type !== 'starcompanion.preview') return;
    if (!Object.hasOwn(text, event.data.state)) return;
    role = ['林澈', '许知夏'].includes(event.data.role) ? event.data.role : '林澈'; show(event.data.state);
  });
  document.addEventListener('DOMContentLoaded', () => {
    // Capture before production handlers: preview clicks cannot start recording or call models.
    for (const id of ['start', 'mute', 'keyboard']) $(id).addEventListener('click', event => {
      event.preventDefault(); event.stopImmediatePropagation();
      if (id === 'start') show('listening');
      if (id === 'mute') show(state === 'muted' ? 'listening' : 'muted');
      if (id === 'keyboard') { $('text-form').hidden = !$('text-form').hidden; if (!$('text-form').hidden) $('text-input').focus(); }
    }, true);
    $('text-form').addEventListener('submit', event => {
      event.preventDefault(); event.stopImmediatePropagation();
      const input = $('text-input').value.trim(); if (!input) return;
      $('text-input').value = ''; $('text-input').blur(); $('text-form').hidden = true;
      $('user-caption').textContent = input; show('thinking');
      timer = setTimeout(() => { show('speaking'); timer = setTimeout(() => show('listening'), 2400); }, 1000);
    }, true);
    $('diagnostics').textContent = '设计预览 · 不录音 · 不连接模型';
    show('ready', false); post('starcompanion.preview.ready');
  });
  window.addEventListener('pagehide', () => { clearTimeout(timer); clearInterval(wave); });
})();
