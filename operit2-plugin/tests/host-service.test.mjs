// SPDX-License-Identifier: MIT
// Copyright (c) 2026 StarCompanion contributors
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { loadTools } from '../scripts/build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.OPERIT2_SOURCE || path.resolve(root, '../../starcompanion-operit2');
const { esbuild } = loadTools(source, root);
const compiled = esbuild.buildSync({ entryPoints: [path.join(root, 'src/host-service.ts')], bundle: true, platform: 'neutral', format: 'cjs', write: false, logLevel: 'silent' }).outputFiles[0].text;
const plain = value => JSON.parse(JSON.stringify(value));
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function eventually(predicate, label = 'condition') {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await delay(2); }
  assert.fail(`Timed out waiting for ${label}`);
}
function load(extra = {}) {
  const context = vm.createContext({ module: { exports: {} }, setTimeout, clearTimeout, ...extra });
  vm.runInContext(compiled, context);
  return { api: context.module.exports, context };
}
const api = load().api;
const chat = id => ({ id, title: `角色 ${id}`, isCurrent: id === 'chat-1' });
const choice = { id: 'voice-1', name: '声音一', providerType: 'openai', responseFormat: 'mp3' };
const receipt = (overrides = {}) => ({ chatId: 'chat-1', aiResponse: '真实完成回复', outcome: { type: 'committed', status: 'completed', userMessageTimestamp: 10, assistant: { messageTimestamp: 20 } }, ...overrides });
const complete = overrides => ({ type: 'completed', result: receipt(overrides) });
const part = (content, revision = 0, messageTimestamp = 20) => ({ type: 'part', chatId: 'chat-1', messageTimestamp, revision, parts: [{ kind: 'markdown', content, sequence: 1 }] });
function queueStream({ pendingReturn = false } = {}) {
  const waiting = [], buffered = [];
  const state = { nextCount: 0, returnCount: 0 };
  return Object.assign(state, {
    push(value) { const result = { done: false, value }; if (waiting.length) waiting.shift().resolve(result); else buffered.push(result); },
    end() { const result = { done: true }; if (waiting.length) waiting.shift().resolve(result); else buffered.push(result); },
    [Symbol.asyncIterator]() { return this; },
    next() { state.nextCount++; if (buffered.length) return Promise.resolve(buffered.shift()); const result = deferred(); waiting.push(result); return result.promise; },
    return() { state.returnCount++; return pendingReturn ? new Promise(() => {}) : Promise.resolve({ done: true }); },
  });
}
function fixture(overrides = {}) {
  const requests = { chats: [], stt: [], reply: [], cancel: [], tts: [] };
  const dependencies = {
    listChats: async params => { requests.chats.push(params); return { currentChatId: 'chat-1', chats: (params.chat_ids || ['chat-1', 'chat-2']).map(chat) }; },
    listTtsConfigs: async () => ({ configs: [choice, { ...choice, id: 'voice-2', name: '声音二' }] }),
    currentTtsConfigId: async () => ({ configId: 'voice-1' }),
    transcribe: async request => { requests.stt.push(request); return { text: '  你好，世界  ' }; },
    sendMessageStreaming: request => { requests.reply.push(request); return (async function* () { yield complete(); })(); },
    cancelChat: async id => { requests.cancel.push(id); return { chatId: id, cancelRequested: false }; },
    synthesize: async request => { requests.tts.push(request); return { segments: [{ audio: [73, 68, 51], contentType: 'audio/mpeg' }] }; },
    timeouts: { inspect: 200, stt: 200, reply: 200, tts: 200, cancel: 20 },
    ...overrides,
  };
  const service = api.createHostService(dependencies);
  return { service, requests, dependencies, receive: payload => service.receive(payload) };
}
async function open(f, extra = {}) { const result = await f.receive({ op: 'open', callId: 'call-1', chatId: 'chat-1', ...extra }); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
async function reply(f, extra = {}) { return f.receive({ op: 'reply', callId: 'call-1', turnId: 'turn-1', text: '你好', ...extra }); }
async function poll(f) { const result = await f.receive({ op: 'poll', callId: 'call-1' }); assert.equal(result.ok, true); return result.value; }
function code(result, expected) { assert.equal(result.ok, false, JSON.stringify(result)); assert.equal(result.error.code, expected); }
function wav({ rate = 16000, channels = 1, bits = 16, samples = 160 } = {}) {
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * channels * bits / 8, 28); bytes.writeUInt16LE(channels * bits / 8, 32); bytes.writeUInt16LE(bits, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  return [...bytes];
}

test('inspect returns only safe voice and chat choices, never provider credentials', async () => {
  const f = fixture({ listTtsConfigs: async () => ({ configs: [{ ...choice, apiKey: 'TOP_SECRET', requestHeaders: { Authorization: 'TOP_SECRET' }, endpoint: 'https://secret.example' }] }) });
  const result = await f.receive({ op: 'inspect', chatId: 'chat-1', listChats: true });
  assert.equal(result.ok, true); assert.deepEqual(plain(result.value.ttsConfigs), [choice]);
  assert.equal(result.value.chat.id, 'chat-1'); assert.equal(result.value.chats.length, 2);
  assert.equal(result.value.promptMode, 'CHAT'); assert.equal(result.value.voiceProfile, 'global-or-manual');
  assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET|secret\.example/);
});

test('request validation rejects unknown fields and malformed identifiers before SDK calls', async () => {
  const f = fixture();
  for (const request of [null, [], { op: 'root' }, { op: 'open', callId: '../unsafe', chatId: 'chat-1' }, { op: 'open', callId: 'a', chatId: 'chat-1', apiKey: 'x' }, { op: 'inspect', listChats: 'yes' }]) code(await f.receive(request), 'INVALID_REQUEST');
  assert.equal(f.requests.chats.length, 0);
});

test('open resolves the exact original chat and locks global or manually selected voice', async () => {
  const f = fixture(); const state = await open(f);
  assert.equal(state.chatId, 'chat-1'); assert.equal(state.voiceMode, 'global'); assert.deepEqual(plain(state.tts), choice);
  assert.deepEqual(plain(f.requests.chats[0]), { chat_ids: ['chat-1'], limit: 1 });
  await f.receive({ op: 'close', callId: 'call-1' });
  const next = await open(f, { callId: 'call-2', ttsConfigId: 'voice-2' }); assert.equal(next.voiceMode, 'manual'); assert.equal(next.tts.id, 'voice-2');
  code(await f.receive({ op: 'open', callId: 'call-3', chatId: 'chat-2', ttsConfigId: 'missing' }), 'TTS_UNAVAILABLE');
});

test('missing global TTS permits honest text-only reply and never synthesizes', async () => {
  const f = fixture({ listTtsConfigs: async () => ({ configs: [] }) }); const state = await open(f);
  assert.equal(state.tts, null); assert.equal(state.ttsError.code, 'TTS_UNAVAILABLE');
  assert.equal((await reply(f)).ok, true);
  code(await f.receive({ op: 'speak', callId: 'call-1', turnId: 'turn-1' }), 'TTS_UNAVAILABLE');
  assert.equal(f.requests.tts.length, 0); assert.equal((await poll(f)).turn.replyText, '真实完成回复');
});

test('same chat is reserved during async open and open-call count is bounded', async () => {
  const first = deferred(); const f = fixture({ listChats: async params => { if (params.chat_ids?.[0] === 'chat-1') return first.promise; return { currentChatId: null, chats: params.chat_ids.map(chat) }; } });
  const pending = open(f);
  code(await f.receive({ op: 'open', callId: 'duplicate', chatId: 'chat-1' }), 'CHAT_BUSY');
  first.resolve({ currentChatId: 'chat-1', chats: [chat('chat-1')] }); await pending;
  for (let i = 2; i <= 4; i++) await open(f, { callId: `call-${i}`, chatId: `chat-${i}` });
  code(await f.receive({ op: 'open', callId: 'call-5', chatId: 'chat-5' }), 'CALL_LIMIT');
});

test('close is idempotent and tombstones prevent both prior and in-flight open resurrection', async () => {
  const pending = deferred(); const f = fixture({ listChats: async () => pending.promise });
  assert.equal((await f.receive({ op: 'close', callId: 'never-open' })).value.snapshot, null);
  code(await f.receive({ op: 'open', callId: 'never-open', chatId: 'chat-1' }), 'CALL_CLOSED');
  const opening = f.receive({ op: 'open', callId: 'call-1', chatId: 'chat-1' });
  assert.equal((await f.receive({ op: 'close', callId: 'call-1' })).ok, true);
  pending.resolve({ currentChatId: 'chat-1', chats: [chat('chat-1')] }); code(await opening, 'CALL_CLOSED');
  code(await f.receive({ op: 'poll', callId: 'call-1' }), 'CALL_CLOSED');
});

test('WAV validation checks actual PCM metadata, lengths and fifteen-second limit before STT', async () => {
  const f = fixture(); await open(f);
  const invalid = [wav({ rate: 48000 }), wav({ channels: 2 }), wav({ bits: 8 }), wav({ samples: 240001 }), wav().slice(0, -1), [...wav(), 0], [NaN, ...wav().slice(1)]];
  for (const audio of invalid) code(await f.receive({ op: 'transcribe', callId: 'call-1', turnId: 'bad-audio', wav: audio }), 'INVALID_AUDIO');
  assert.equal(f.requests.stt.length, 0);
  const result = await f.receive({ op: 'transcribe', callId: 'call-1', turnId: 'turn-1', wav: wav() });
  assert.equal(result.ok, true); assert.equal(result.value.text, '你好，世界');
  assert.equal(f.requests.stt[0].contentType, 'audio/wav'); assert.equal(f.requests.stt[0].fileName, 'voice-turn.wav');
  code(await f.receive({ op: 'transcribe', callId: 'call-1', turnId: 'turn-1', wav: wav() }), 'DUPLICATE_TURN');
});

test('late STT after cancel is discarded and cannot mutate a new turn', async () => {
  const speech = deferred(); const f = fixture({ transcribe: async () => speech.promise }); await open(f);
  const pending = f.receive({ op: 'transcribe', callId: 'call-1', turnId: 'old', wav: wav() });
  const stopped = await f.receive({ op: 'cancel', callId: 'call-1', turnId: 'old' }); assert.equal(stopped.value.remoteSpeechMayContinue, true);
  assert.equal((await reply(f, { turnId: 'new' })).ok, true);
  speech.resolve({ text: '迟到的录音' }); code(await pending, 'STALE_RESULT');
  assert.equal((await poll(f)).turn.turnId, 'new'); assert.equal(f.requests.cancel.length, 0);
});

test('reply uses original chat main execution once and commits only a real completion receipt', async () => {
  const f = fixture(); await open(f); const result = await reply(f, { text: ' 保留原始输入 ' }); assert.equal(result.ok, true);
  assert.deepEqual(plain(f.requests.reply), [{ kind: 'submit', chatId: 'chat-1', runtime: 'main', input: { text: ' 保留原始输入 ', attachments: [], replyToMessageTimestamp: null }, turn: { kind: 'execute' }, notifyReply: false }]);
  assert.deepEqual(plain(result.value.receipt), { persistence: 'committed', userMessageTimestamp: 10, assistantMessageTimestamp: 20 });
  assert.equal(result.value.snapshot.replySettling, false);
  code(await reply(f), 'DUPLICATE_TURN'); assert.equal(f.requests.reply.length, 1);
});

test('stream subtitles replace snapshots, accept first revision zero, and scope revision to message', async () => {
  const stream = queueStream(); const f = fixture({ sendMessageStreaming: () => stream }); await open(f);
  const pending = reply(f); await eventually(() => stream.nextCount === 1);
  stream.push(part('首个零版本', 0, 20)); await eventually(async () => (await poll(f)).turn.subtitle === '首个零版本');
  stream.push({ ...part('完整快照', 1, 20), parts: [{ kind: 'markdown', content: '第二段', sequence: 2 }, { kind: 'thinking', content: '私有推理', sequence: 0 }, { kind: 'markdown', content: '第一段', sequence: 1 }] });
  await eventually(async () => (await poll(f)).turn.subtitle === '第一段\n第二段');
  stream.push(part('新消息零版本', 0, 30)); await eventually(async () => (await poll(f)).turn.subtitle === '新消息零版本');
  stream.push(part('旧消息迟到更新', 99, 20)); await eventually(() => stream.nextCount >= 5);
  assert.equal((await poll(f)).turn.subtitle, '新消息零版本');
  stream.push(part('重复零版本应忽略', 0, 30)); stream.push(complete());
  assert.equal((await pending).ok, true); assert.equal((await poll(f)).turn.subtitle, '真实完成回复');
});

for (const [outcome, expected] of [
  [{ type: 'committed', status: 'cancelled' }, 'CANCELLED'],
  [{ type: 'not_persisted', status: 'cancelled' }, 'CANCELLED'],
  [{ type: 'blocked', message: 'TOP_SECRET' }, 'INPUT_BLOCKED'],
  [{ type: 'consumed', metadata: { key: 'TOP_SECRET' } }, 'INPUT_CONSUMED'],
]) test(`receipt outcome ${outcome.type}/${outcome.status || ''} never becomes spoken success`, async () => {
  const f = fixture({ sendMessageStreaming: () => (async function* () { yield complete({ outcome }); })() }); await open(f);
  const result = await reply(f); code(result, expected); assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET/);
  code(await f.receive({ op: 'speak', callId: 'call-1', turnId: 'turn-1' }), 'REPLY_NOT_READY');
});

test('stream end without completion fails and sanitizes provider errors', async () => {
  const f = fixture({ sendMessageStreaming: () => (async function* () {})() }); await open(f);
  code(await reply(f), 'MISSING_COMPLETION');
  const broken = fixture({ transcribe: async () => { throw new Error('apiKey=TOP_SECRET provider failed'); } }); await open(broken);
  const result = await broken.receive({ op: 'transcribe', callId: 'call-1', turnId: 'turn-1', wav: wav() }); code(result, 'STT_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET/);
});

test('cancel affects only an owned reply and stale turn cancellation cannot touch the current turn', async () => {
  const stream = queueStream(); const f = fixture({ sendMessageStreaming: () => stream }); await open(f);
  await f.receive({ op: 'cancel', callId: 'call-1' }); assert.equal(f.requests.cancel.length, 0);
  const pending = reply(f, { turnId: 'new' }); await eventually(() => stream.nextCount === 1);
  code(await f.receive({ op: 'cancel', callId: 'call-1', turnId: 'old' }), 'STALE_TURN'); assert.equal(f.requests.cancel.length, 0);
  const result = await f.receive({ op: 'cancel', callId: 'call-1', turnId: 'new' }); assert.equal(result.ok, true); assert.deepEqual(f.requests.cancel, ['chat-1']);
  stream.push(complete()); code(await pending, 'STALE_RESULT');
});

for (const cancellation of ['false', 'unresolved']) test(`pending first next plus timeout and ${cancellation} cancel retains settling barrier until late completed`, async () => {
  const stream = queueStream({ pendingReturn: true }); let cancelCount = 0;
  const f = fixture({ sendMessageStreaming: () => stream, cancelChat: async id => { cancelCount++; return cancellation === 'false' ? { chatId: id, cancelRequested: false } : new Promise(() => {}); }, timeouts: { inspect: 100, stt: 100, reply: 12, tts: 100, cancel: 3 } });
  await open(f); code(await reply(f), 'TIMEOUT'); assert.equal(cancelCount, 1);
  await delay(20); assert.equal((await poll(f)).replySettling, true); assert.equal(stream.returnCount, 0);
  code(await reply(f, { turnId: 'turn-2' }), 'TURN_BUSY');
  await f.receive({ op: 'close', callId: 'call-1' });
  code(await f.receive({ op: 'open', callId: 'call-2', chatId: 'chat-1' }), 'CHAT_BUSY');
  stream.push(complete());
  await eventually(async () => (await f.receive({ op: 'open', callId: 'call-3', chatId: 'chat-1' })).ok, 'late completion release');
  assert.equal(stream.returnCount, 1); await delay(10);
});

test('iterator.return timeout alone never frees an unconfirmed native execution', async () => {
  const stream = queueStream({ pendingReturn: true });
  const f = fixture({ sendMessageStreaming: () => stream, cancelChat: async id => ({ chatId: id, cancelRequested: true }), timeouts: { inspect: 100, stt: 100, reply: 12, tts: 100, cancel: 3 } });
  await open(f); const pending = reply(f); await eventually(() => stream.nextCount === 1);
  stream.push(part('已开始', 0)); await eventually(() => stream.nextCount === 2);
  code(await pending, 'TIMEOUT'); await delay(20); assert.equal((await poll(f)).replySettling, true);
  stream.push(complete()); await eventually(async () => !(await poll(f)).replySettling);
  await delay(8); assert.equal(stream.returnCount, 1);
});

test('encoded TTS uses locked voice and committed reply without a second chat request', async () => {
  const f = fixture(); await open(f, { ttsConfigId: 'voice-2' }); assert.equal((await reply(f)).ok, true);
  const result = await f.receive({ op: 'speak', callId: 'call-1', turnId: 'turn-1' }); assert.equal(result.ok, true);
  assert.deepEqual(plain(f.requests.tts), [{ text: '真实完成回复', configId: 'voice-2' }]);
  assert.deepEqual(plain(result.value.segments), [{ audio: [73, 68, 51], contentType: 'audio/mpeg' }]);
  assert.equal(f.requests.reply.length, 1); code(await f.receive({ op: 'speak', callId: 'call-1', turnId: 'turn-1' }), 'REPLY_NOT_READY');
});

for (const [segments, expected] of [
  [[], 'INVALID_SPEECH'],
  [[{ audio: [0, 1], contentType: 'application/octet-stream' }], 'UNSUPPORTED_AUDIO'],
  [[{ audio: [], contentType: 'audio/mpeg' }], 'UNSUPPORTED_AUDIO'],
  [[{ audio: [256], contentType: 'audio/wav' }], 'INVALID_SPEECH'],
  [[{ audio: Array(8 * 1024 * 1024 + 1).fill(0), contentType: 'audio/wav' }], 'INVALID_SPEECH'],
]) test(`invalid TTS ${expected}/${segments[0]?.audio.length || 0} retains committed text and never resends`, async () => {
  const f = fixture({ synthesize: async () => ({ segments }) }); await open(f); await reply(f);
  code(await f.receive({ op: 'speak', callId: 'call-1', turnId: 'turn-1' }), expected);
  assert.equal((await poll(f)).turn.replyText, '真实完成回复'); assert.equal(f.requests.reply.length, 1);
});

test('late TTS after close returns no bytes and cannot resurrect the call', async () => {
  const synthesis = deferred(); const f = fixture({ synthesize: async () => synthesis.promise }); await open(f); await reply(f);
  const pending = f.receive({ op: 'speak', callId: 'call-1', turnId: 'turn-1' });
  const closed = await f.receive({ op: 'close', callId: 'call-1' }); assert.equal(closed.value.remoteSpeechMayContinue, true);
  synthesis.resolve({ segments: [{ audio: [1, 2, 3], contentType: 'audio/mpeg' }] }); const result = await pending;
  code(result, 'STALE_RESULT'); assert.equal(result.value, undefined); code(await f.receive({ op: 'poll', callId: 'call-1' }), 'CALL_CLOSED');
});

test('default SDK adapter uses the real Operit JavaScript timer prelude and cleans timer scopes', async () => {
  const prelude = readFileSync(path.join(source, 'core/crates/plugin/javascript-bridge/src/javascript/JsLibraries.rs'), 'utf8');
  const start = prelude.indexOf('        var intervalStates = {{}};');
  const end = prelude.indexOf('        /** Schedules a repeating timer', start);
  assert.ok(start > 0 && end > start, 'actual runtime timer implementation must be present');
  const timers = prelude.slice(start, end).replaceAll('{{', '{').replaceAll('}}', '}');
  const scheduled = new Map(), scopes = new Set(); let nativeFailures = 0;
  const context = vm.createContext({ module: { exports: {} }, __operitCurrentCallId: 'ipc-call',
    __operitRegisterCallTimer: (_call, id) => scopes.add(id),
    __operitUnregisterCallTimer: (_call, id) => scopes.delete(id),
    __operitNativeScheduleJavaScriptTimer: (id, milliseconds) => new Promise(resolve => scheduled.set(id, { milliseconds, resolve })),
    __operitNativeCancelJavaScriptPromises: id => scheduled.delete(id),
    __operitActivateCall: () => {}, __operitGetCallState: () => ({ completed: false, callRuntime: { fail: () => nativeFailures++ } }),
    Tools: { Chat: { listChats: async () => new Promise(() => {}) }, Tts: { listConfigs: async () => ({ configs: [choice] }), getCurrentConfigId: async () => ({ configId: choice.id }) } },
  });
  vm.runInContext('var window = globalThis;\n' + timers + '\n' + compiled, context);
  const id = vm.runInContext('setTimeout(function(){}, 42)', context); assert.equal(typeof id, 'string'); assert.match(id, /^__operit_timer_/);
  context.clearTimeout(id); assert.equal(scopes.size, 0);
  const pending = context.module.exports.createDefaultHostService().receive({ op: 'inspect' });
  await eventually(() => [...scheduled.values()].some(timer => timer.milliseconds === 15000));
  await delay(0); // let successful config requests clear their exact host scopes
  const stillPending = [...scheduled.entries()]; assert.equal(stillPending.length, 1);
  scheduled.delete(stillPending[0][0]); stillPending[0][1].resolve();
  code(await pending, 'TIMEOUT'); await delay(0);
  assert.equal(scopes.size, 0); assert.equal(scheduled.size, 0); assert.equal(nativeFailures, 0);
});

test('real SDK pull iterator validates part/completed ABI and disposes before yielding receipt', async () => {
  const runtime = readFileSync(path.join(source, 'core/crates/plugin/sdk/src/chat_runtime.js'), 'utf8');
  const events = [part('SDK 真实 part', 0), complete()], operations = [];
  const context = vm.createContext({ __operitSnapshotJsonObject: value => plain(value), toolCall: async (_name, { observation }) => {
    operations.push(observation.op);
    if (observation.op === 'open') return { type: 'open', handle: 'private-observation' };
    if (observation.op === 'next') return { type: 'next', event: events.shift() ?? null };
    return { type: 'close' };
  } });
  vm.runInContext(runtime, context);
  const f = fixture({ sendMessageStreaming: request => context.__operitCreateToolStream('chat_observe', request) });
  await open(f); const result = await reply(f); assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(operations, ['open', 'next', 'next', 'close']); assert.equal(result.value.snapshot.turn.replyText, '真实完成回复');
});

test('real SDK terminal disposal failure gets safe fixed context diagnostic, with no resend', async () => {
  const runtime = readFileSync(path.join(source, 'core/crates/plugin/sdk/src/chat_runtime.js'), 'utf8');
  let sends = 0;
  const context = vm.createContext({ __operitSnapshotJsonObject: value => plain(value), toolCall: async (_name, { observation }) => {
    if (observation.op === 'open') { sends++; return { handle: 'private-observation' }; }
    if (observation.op === 'next') return { event: complete() };
    throw new Error('ToolPkg API execution state unavailable for call TEST_PRIVATE_CONTEXT apiKey=TOP_SECRET');
  } });
  vm.runInContext(runtime, context);
  const f = fixture({ sendMessageStreaming: request => context.__operitCreateToolStream('chat_observe', request) });
  await open(f); const result = await reply(f); code(result, 'CHAT_STREAM_CONTEXT_FAILED');
  assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET|TEST_PRIVATE_CONTEXT/); assert.equal(sends, 1);
});

test('production factory submits once with canonical sendMessage receipt and never opens observation streaming', async () => {
  const sent = [], spoken = [], pending = deferred(); let observations = 0;
  const { api: native } = load({ Tools: {
    Chat: {
      listChats: async () => ({ currentChatId: 'chat-1', chats: [chat('chat-1')] }),
      sendMessage: async request => { sent.push(request); return pending.promise; },
      sendMessageStreaming: () => { observations++; throw new Error('Observation must not be opened'); },
      cancel: async id => ({ chatId: id, cancelRequested: false }),
    },
    Tts: {
      listConfigs: async () => ({ configs: [choice] }), getCurrentConfigId: async () => ({ configId: choice.id }),
      synthesize: async request => { spoken.push(request); return { segments: [{ audio: [73, 68, 51], contentType: 'audio/mpeg' }] }; },
    },
  } });
  const service = native.createDefaultHostService(), f = { receive: payload => service.receive(payload) };
  await open(f); const answering = reply(f, { text: '全新测试轮次' });
  await eventually(() => sent.length === 1);
  const during = await poll(f); assert.equal(during.turn.phase, 'replying'); assert.equal(during.turn.subtitle, '');
  pending.resolve(receipt()); const result = await answering; assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.snapshot.turn.replyText, '真实完成回复'); assert.equal(result.value.receipt.persistence, 'committed');
  assert.equal((await f.receive({ op: 'speak', callId: 'call-1', turnId: 'turn-1' })).ok, true);
  assert.equal(sent.length, 1); assert.equal(observations, 0); assert.deepEqual(plain(spoken), [{ text: '真实完成回复', configId: choice.id }]);
});

test('production canonical send failure never triggers an observation or automatic resubmission', async () => {
  let sends = 0, observations = 0;
  const { api: native } = load({ Tools: {
    Chat: { listChats: async () => ({ currentChatId: 'chat-1', chats: [chat('chat-1')] }),
      sendMessage: async () => { sends++; throw new Error('provider private failure apiKey=TOP_SECRET'); },
      sendMessageStreaming: () => { observations++; throw new Error('No fallback'); },
      cancel: async id => ({ chatId: id, cancelRequested: false }) },
    Tts: { listConfigs: async () => ({ configs: [choice] }), getCurrentConfigId: async () => ({ configId: choice.id }) },
  } });
  const service = native.createDefaultHostService(), f = { receive: payload => service.receive(payload) };
  await open(f); const result = await reply(f); code(result, 'CHAT_STREAM_PULL_FAILED'); assert.doesNotMatch(JSON.stringify(result), /TOP_SECRET/);
  assert.equal(sends, 1); assert.equal(observations, 0);
});
