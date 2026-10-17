import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import * as audio from '../web/audio-core.mjs';

const app = await readFile(new URL('../web/app.js', import.meta.url), 'utf8');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let n = 0; n < 12; n++) await new Promise(resolve => setImmediate(resolve)); };
function element() {
  return { hidden: false, disabled: false, textContent: '', value: '', style: {}, children: [], handlers: {}, options: [],
    addEventListener(type, handler) { this.handlers[type] = handler; },
    querySelector() { return this.small ||= element(); },
    add(option) { this.options.push(option); }, focus() {}, blur() {},
    setAttribute(key, value) { this[key] = value; },
  };
}
async function page({ chat = { id: 'bound-chat', title: '林澈' }, handler = async () => ({}), mediaDevices, AudioContextClass } = {}) {
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('wave').children = Array.from({ length: 9 }, element);
  get('text-form').hidden = true; get('chat-label').hidden = true;
  const calls = [], listeners = {}, intervals = new Map(); let timer = 0;
  const initial = { chat, currentChatId: 'unrelated-global-chat', chats: [{ id: 'chosen-chat', title: '许知夏' }], ttsConfigs: [] };
  const document = { hidden: false, getElementById: get, addEventListener(type, callback) { listeners[type] = callback; } };
  const window = { isSecureContext: true, AudioContext: AudioContextClass, StarVoice: { async request([payload]) {
    calls.push(payload);
    if (payload.op === 'bootstrap') return { ok: true, value: initial };
    return { ok: true, value: await handler(payload) };
  } }, addEventListener(type, callback) { listeners[type] = callback; } };
  const sandbox = { window, document, navigator: { mediaDevices }, crypto: webcrypto, StarVoiceAudio: audio, setInterval(callback) { intervals.set(++timer, callback); return timer; }, clearInterval(id) { intervals.delete(id); }, Option: function(text, value) { this.text = text; this.value = value; }, URL, Blob, console };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(app, sandbox, { filename: 'voice-app.js' }); await flush();
  const click = async id => { await get(id).handlers.click(); await flush(); };
  const submit = async text => { get('text-input').value = text; await get('text-form').handlers.submit({ preventDefault() {} }); await flush(); };
  return { get, calls, window, document, listeners, intervals, click, submit };
}

test('without an explicit conversation the page never guesses the globally current chat', async () => {
  const p = await page({ chat: null });
  assert.equal(p.get('chat-label').hidden, false);
  await p.click('keyboard');
  assert.equal(p.calls.filter(call => call.op === 'open').length, 0);
  p.get('chat').value = 'chosen-chat'; await p.click('keyboard');
  assert.equal(p.calls.find(call => call.op === 'open').chatId, 'chosen-chat');
  await p.window.StarCompanionCall.hangup();
});
test('simultaneous start and keyboard actions share one in-flight open', async () => {
  const opened = deferred();
  const p = await page({ handler: payload => payload.op === 'open' ? opened.promise : {} });
  const first = p.get('start').handlers.click();
  const second = p.get('keyboard').handlers.click(); await flush();
  assert.equal(p.calls.filter(call => call.op === 'open').length, 1);
  opened.resolve({}); await Promise.all([first, second]);
  assert.match(p.get('notice').textContent, /麦克风接口/);
  await p.window.StarCompanionCall.hangup();
});
test('closing during open closes the late session and never starts the microphone', async () => {
  const opened = deferred();
  const p = await page({ handler: payload => payload.op === 'open' ? opened.promise : {} });
  const first = p.get('start').handlers.click(); await flush();
  await p.window.StarCompanionCall.hangup(); opened.resolve({}); await first; await flush();
  const open = p.calls.find(call => call.op === 'open');
  assert.ok(p.calls.some(call => call.op === 'close' && call.callId === open.callId));
  assert.equal(p.get('status').textContent, '通话已结束');
  assert.equal(p.intervals.size, 0);
});
test('a late reply after interruption is discarded and never synthesized or repeated', async () => {
  const firstReply = deferred(); let replies = 0;
  const p = await page({ handler: payload => {
    if (payload.op === 'reply') { replies++; return replies === 1 ? firstReply.promise : { snapshot: { turn: { replyText: '' } } }; }
    return {};
  } });
  await p.click('keyboard'); await p.submit('第一句话');
  assert.equal(replies, 1);
  await p.submit('第二句话');
  assert.ok(p.calls.some(call => call.op === 'cancel'));
  firstReply.resolve({ snapshot: { turn: { replyText: '迟到的旧回复' } } }); await flush();
  assert.equal(replies, 2);
  assert.equal(p.calls.filter(call => call.op === 'speak').length, 0);
  assert.equal(p.get('user-caption').textContent, '第二句话');
  assert.notEqual(p.get('reply-caption').textContent, '迟到的旧回复');
  await p.window.StarCompanionCall.hangup();
});
test('leaving the foreground closes the owned call and disables further input', async () => {
  const p = await page(); await p.click('keyboard');
  p.document.hidden = true; p.listeners.visibilitychange(); await flush();
  assert.equal(p.calls.filter(call => call.op === 'close').length, 1);
  assert.equal(p.get('text-send').disabled, true);
  assert.equal(p.intervals.size, 0);
});
test('microphone source failures show actionable permission and device guidance', async () => {
  const p = await page({ mediaDevices: { async getUserMedia() { const error = new Error('Could not start audio source'); error.name = 'NotReadableError'; throw error; } } });
  await p.click('start');
  assert.match(p.get('notice').textContent, /麦克风权限/);
  assert.match(p.get('notice').textContent, /其他应用占用/);
  assert.equal(p.get('mute').disabled, true);
  await p.window.StarCompanionCall.hangup();
});
test('Web Audio is unlocked before asynchronous work and hangup stops its owned source', async () => {
  const events = [], sources = [];
  class OutputContext {
    constructor() { this.state = 'suspended'; this.sampleRate = 48000; this.destination = {}; events.push('context'); }
    resume() { events.push('resume'); this.state = 'running'; return Promise.resolve(); }
    createBuffer() { return { silent: true }; }
    createBufferSource() {
      const source = { connect() {}, disconnect() { events.push('disconnect'); }, start() { events.push(this.buffer.silent ? 'silent' : 'play'); }, stop() { events.push('stop'); } };
      sources.push(source); return source;
    }
    async decodeAudioData(buffer) { assert.equal(buffer.byteLength, 4); events.push('decode'); return { silent: false }; }
    async close() { this.state = 'closed'; events.push('close'); }
  }
  const p = await page({ AudioContextClass: OutputContext, handler: payload => {
    events.push(payload.op);
    if (payload.op === 'reply') return { snapshot: { turn: { replyText: '你好。' } } };
    if (payload.op === 'speak') return { segments: [{ audio: [1, 2, 3, 4], contentType: 'audio/wav' }] };
    return {};
  } });
  await p.click('keyboard');
  assert.ok(events.indexOf('resume') < events.indexOf('open'));
  await p.submit('你好');
  assert.ok(events.indexOf('reply') < events.indexOf('speak'));
  assert.ok(events.indexOf('decode') < events.indexOf('play'));
  assert.equal(p.get('reply-caption').textContent, '你好。');
  await p.window.StarCompanionCall.hangup(); await flush();
  assert.ok(events.includes('stop')); assert.ok(events.includes('close'));
  assert.equal(sources[1].onended, null);
});
