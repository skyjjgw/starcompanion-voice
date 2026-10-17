/* Original StarCompanion implementation. SPDX-License-Identifier: MIT */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { MonoResampler, SpeechSegmenter, encodeWav } = globalThis.StarVoiceAudio;
  let info, callId = null, generation = 0, currentTurn = null, stream, context, processor, source, sink, segmenter;
  let muted = false, listening = false, ended = false, queue = Promise.resolve(), busy = false, startedAt = 0;
  let playback = null, finishPlayback = null, outputContext = null, pollTimer = null, opening = null;
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
  const setStatus = (value) => { $('status').textContent = value; };
  const notice = (value = '') => { $('notice').textContent = value; };
  const isCurrent = (epoch) => !ended && !!callId && epoch === generation;

  async function request(payload) {
    if (!window.StarVoice || typeof window.StarVoice.request !== 'function') throw new Error('插件通信尚未就绪，请关闭此页面后重试。');
    let result = await window.StarVoice.request([payload]);
    if (typeof result === 'string') { try { result = JSON.parse(result); } catch { throw new Error('插件返回了无效响应。'); } }
    if (!result || result.ok !== true) {
      const error = new Error(result?.error?.message || '插件调用未完成，请重试。');
      error.code = result?.error?.code;
      throw error;
    }
    return result.value;
  }

  function setIdentity(chat) {
    const name = chat?.title || chat?.name || '当前对话';
    $('title').textContent = name; $('title').title = name; $('avatar').textContent = '伴';
  }

  function stopPlayback() {
    if (playback) { playback.onended = null; try { playback.stop(); } catch { /* Already stopped. */ } playback.disconnect(); playback = null; }
    if (finishPlayback) { const finish = finishPlayback; finishPlayback = null; finish(false); }
  }

  // Called synchronously from a user click, before any provider or configuration awaits.
  function primeOutput() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    if (!outputContext || outputContext.state === 'closed') outputContext = new AudioContextClass();
    void outputContext.resume().catch(() => { notice('音频输出尚未启动，请再次点击键盘输入或重新开始通话。'); });
    const silent = outputContext.createBufferSource();
    silent.buffer = outputContext.createBuffer(1, 1, outputContext.sampleRate);
    silent.connect(outputContext.destination); silent.onended = () => silent.disconnect(); silent.start();
  }

  async function interrupt() {
    generation++;
    stopPlayback();
    if (callId && currentTurn) {
      try { await request({ op: 'cancel', callId, turnId: currentTurn }); } catch { /* The next action will surface connection errors. */ }
    }
  }

  function stopCapture() {
    listening = false;
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null; }
    if (source) { source.disconnect(); source = null; }
    if (sink) { sink.disconnect(); sink = null; }
    if (stream) { stream.getTracks().forEach(track => track.stop()); stream = null; }
    if (context) { const old = context; context = null; old.close().catch(() => {}); }
    segmenter?.reset(); segmenter = null;
    $('mute').disabled = true;
    paintLevel(0);
  }

  async function hangup() {
    if (ended) return;
    ended = true; generation++;
    stopCapture(); stopPlayback();
    if (outputContext) { const old = outputContext; outputContext = null; old.close().catch(() => {}); }
    clearInterval(pollTimer); clearInterval(clockTimer);
    const closing = callId; callId = null;
    setStatus('通话已结束');
    $('start').disabled = true; $('keyboard').disabled = true; $('text-send').disabled = true;
    if (closing) { try { await request({ op: 'close', callId: closing }); } catch { /* Native footer repeats close as a fallback. */ } }
  }
  window.StarCompanionCall = { hangup };
  window.addEventListener('pagehide', () => { void hangup(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) void hangup(); });

  async function ensureSession() {
    if (ended) throw new Error('通话已结束，请关闭页面后重新打开。');
    if (callId) return;
    if (opening) return opening;
    opening = openSession();
    try { await opening; } finally { opening = null; }
  }

  async function openSession() {
    const chatId = info?.chat?.id || $('chat').value;
    if (!chatId) throw new Error('请先选择一个已有的单角色对话。');
    const candidate = uid();
    const snapshot = await request({ op: 'open', callId: candidate, chatId, ttsConfigId: $('voice').value || null });
    if (ended) { await request({ op: 'close', callId: candidate }); return; }
    callId = candidate; startedAt = Date.now();
    $('configuration').hidden = true;
    if (snapshot?.ttsError) notice(typeof snapshot.ttsError === 'string' ? snapshot.ttsError : snapshot.ttsError.message || '语音合成尚未配置，仍可显示字幕。');
    pollTimer = setInterval(async () => {
      if (!callId || !busy) return;
      const expectedCall = callId, expectedTurn = currentTurn, expectedGeneration = generation;
      try {
        const snapshot = await request({ op: 'poll', callId: expectedCall });
        if (generation === expectedGeneration && callId === expectedCall && currentTurn === expectedTurn && snapshot?.turn?.turnId === expectedTurn && snapshot.turn.subtitle) $('reply-caption').textContent = snapshot.turn.subtitle;
      } catch { /* Active action reports its own error. */ }
    }, 750);
  }

  async function capture() {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('此 WebView 未提供安全的麦克风接口，请更新 Android System WebView；也可先使用键盘输入。');
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    if (ended) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) { stopCapture(); throw new Error('当前 WebView 不支持 Web Audio，请更新系统 WebView。'); }
    context = new AudioContextClass(); await context.resume();
    if (ended) { stopCapture(); return; }
    const resampler = new MonoResampler(context.sampleRate);
    segmenter = new SpeechSegmenter({
      onLevel: paintLevel,
      onStart: () => { void interrupt(); setStatus('正在听你说话…'); },
      onSegment: (samples) => { enqueue({ wav: Array.from(encodeWav(samples)) }); },
    });
    source = context.createMediaStreamSource(stream);
    processor = context.createScriptProcessor(2048, 1, 1);
    sink = context.createGain(); sink.gain.value = 0;
    processor.onaudioprocess = event => {
      if (!muted && !ended) segmenter?.push(resampler.push(event.inputBuffer.getChannelData(0)));
    };
    source.connect(processor); processor.connect(sink); sink.connect(context.destination);
    listening = true; muted = false;
    $('mute').disabled = false; $('mute').setAttribute('aria-pressed', 'false');
    $('start').disabled = true; $('start').querySelector('small').textContent = '通话中';
    setStatus('正在聆听');
    $('diagnostics').textContent += ` · 采样 ${context.sampleRate} Hz → 16000 Hz`;
  }

  function paintLevel(level) {
    [...$('wave').children].forEach((bar, index) => { bar.style.height = `${6 + level * 38 * (0.35 + Math.sin(index * 1.3) ** 2 * 0.65)}px`; });
  }

  function enqueue(input) {
    if (!callId || ended) return;
    const epoch = generation;
    queue = queue.catch(() => {}).then(() => isCurrent(epoch) ? processTurn(input, epoch) : undefined);
  }

  async function processTurn(input, epoch) {
    if (!isCurrent(epoch)) return;
    const turnId = uid(); currentTurn = turnId; busy = true; notice();
    try {
      let text = input.text;
      if (!text) {
        setStatus('正在识别…');
        const recognized = await request({ op: 'transcribe', callId, turnId, wav: input.wav });
        if (!isCurrent(epoch)) return;
        text = recognized.text?.trim();
        if (!text) { setStatus(listening ? '没有听清，请再说一次' : '没有识别到文字'); return; }
      }
      $('user-caption').textContent = text; $('reply-caption').textContent = '';
      setStatus('正在回复…');
      const response = await request({ op: 'reply', callId, turnId, text });
      if (!isCurrent(epoch)) return;
      const reply = response.snapshot?.turn?.replyText || response.snapshot?.turn?.subtitle || '';
      $('reply-caption').textContent = reply || '本次回复没有可朗读的文字。';
      if (!reply) return;
      setStatus('正在合成语音…');
      const speech = await request({ op: 'speak', callId, turnId });
      if (!isCurrent(epoch)) return;
      setStatus('正在说话 · 可直接打断');
      for (const segment of speech.segments) {
        if (!isCurrent(epoch)) break;
        const finished = await playSegment(segment, epoch);
        if (!finished) break;
      }
    } catch (error) {
      if (isCurrent(epoch)) notice(error.message || '通话处理失败，请检查配置后重试。');
    } finally {
      if (currentTurn === turnId) busy = false;
      if (isCurrent(epoch)) setStatus(listening ? (muted ? '麦克风已静音' : '正在聆听') : '键盘对话');
    }
  }

  async function playSegment(segment, epoch) {
    if (!Array.isArray(segment.audio) || !segment.audio.length) throw new Error('语音服务返回了空音频。');
    stopPlayback();
    const output = outputContext;
    if (!output || output.state !== 'running') throw new Error('音频输出未获启动，请点击键盘输入按钮后重试；文字回复仍保留。');
    let buffer;
    try { buffer = await output.decodeAudioData(Uint8Array.from(segment.audio).buffer); }
    catch { throw new Error('当前 WebView 无法解码该音频，请在 TTS 设置中选择 WAV 或 MP3。'); }
    if (!isCurrent(epoch) || outputContext !== output) return false;
    const audio = output.createBufferSource(); audio.buffer = buffer; audio.connect(output.destination); playback = audio;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value, error) => {
        if (settled) return; settled = true;
        if (finishPlayback === finish) finishPlayback = null;
        audio.onended = null;
        if (error) reject(error); else resolve(value);
      };
      finishPlayback = finish;
      audio.onended = () => finish(true);
      try { audio.start(); } catch { finish(false, new Error('音频播放失败，请重新打开通话并检查媒体音量。')); }
    }).finally(() => { if (playback === audio) stopPlayback(); });
  }

  $('start').addEventListener('click', async () => {
    $('start').disabled = true; notice();
    try { primeOutput(); await ensureSession(); if (!ended) await capture(); }
    catch (error) {
      stopCapture();
      notice(error.name === 'NotAllowedError' || error.name === 'SecurityError'
        ? '麦克风未获授权。请在 Android 设置 → 应用 → 星伴 → 权限中允许麦克风，再重新打开通话；也可使用键盘输入。'
        : error.name === 'NotReadableError'
          ? '无法启动麦克风。请检查 Android 设置中本应用的麦克风权限，并确认没有其他应用占用；也可使用键盘输入。'
          : error.message);
      setStatus('麦克风未开始'); $('start').disabled = false;
    }
  });
  $('mute').addEventListener('click', () => {
    muted = !muted; stream?.getAudioTracks().forEach(track => { track.enabled = !muted; }); segmenter?.reset();
    $('mute').setAttribute('aria-pressed', String(muted)); $('mute').querySelector('small').textContent = muted ? '取消静音' : '静音';
    if (!busy) setStatus(muted ? '麦克风已静音' : '正在聆听'); paintLevel(0);
  });
  $('keyboard').addEventListener('click', async () => {
    notice();
    try { primeOutput(); await ensureSession(); if (ended) return; $('text-form').hidden = !$('text-form').hidden; if (!$('text-form').hidden) $('text-input').focus(); if (!listening) setStatus('键盘对话'); }
    catch (error) { notice(error.message); }
  });
  $('text-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const text = $('text-input').value.trim(); if (!text) return;
    $('text-input').value = ''; $('text-input').blur();
    await interrupt(); enqueue({ text });
  });
  $('chat').addEventListener('change', () => setIdentity(info?.chats?.find(chat => chat.id === $('chat').value)));
  const clockTimer = setInterval(() => {
    if (!startedAt || ended) return;
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    $('timer').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000);
  async function bootstrap() {
    $('start').disabled = true; $('keyboard').disabled = true;
    $('diagnostics').textContent = `安全上下文：${window.isSecureContext ? '是' : '否'} · 麦克风接口：${navigator.mediaDevices?.getUserMedia ? '可用' : '不可用'}`;
    try {
      info = await request({ op: 'bootstrap' });
      setIdentity(info.chat);
      if (!info.chat?.id) {
        $('chat-label').hidden = false;
        const placeholder = new Option('请选择已有的单角色对话', ''); $('chat').add(placeholder);
        for (const chat of info.chats || []) $('chat').add(new Option(chat.title || chat.name || chat.id, chat.id));
      }
      for (const voice of info.ttsConfigs || []) $('voice').add(new Option(voice.name || voice.id, voice.id));
      if (info.ttsError) notice(typeof info.ttsError === 'string' ? info.ttsError : info.ttsError.message);
      setStatus('准备好后，开始通话'); $('start').disabled = false; $('keyboard').disabled = false;
    } catch (error) { setStatus('插件连接失败'); notice(error.message); }
  }
  void bootstrap();
})();
