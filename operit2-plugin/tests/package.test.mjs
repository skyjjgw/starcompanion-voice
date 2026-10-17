import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { buildPlugin, createArchive, verifyArchive, crc32, inlineDocument, loadTools } from '../scripts/build.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.env.OPERIT2_SOURCE || path.resolve(root, '../../starcompanion-operit2');
const cache = path.resolve(process.env.STARCOMPANION_VOICE_BUILD_CACHE || path.resolve(root, '../../starcompanion-voice-build-cache'));

async function fixture(t) {
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(path.join(cache, 'package-test-'));
  t.after(async () => {
    if (!path.resolve(folder).startsWith(cache + path.sep)) throw new Error('Refusing cleanup outside test cache');
    await rm(folder, { recursive: true, force: true });
  });
  const inputs = {
    'package.json': '{"name":"voice-package-fixture","private":true}',
    'manifest.json': JSON.stringify({ schema_version: 1, toolpkg_id: 'com.skymoni.voice_calls', api_version: '2.0.0', version: '0.1.0', main: 'dist/main.js', resources: [{ key: 'voice_web', path: 'resources/voice.html', mime: 'text/html' }] }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'ES2020', module: 'CommonJS', moduleResolution: 'Node', skipLibCheck: true, lib: ['ES2020'] }, include: ['src/**/*.ts'] }),
    'README.md': 'Packaging behavior fixture, not an audio acceptance test.\n',
    'LICENSE': 'MIT fixture\n',
    'src/main.ts': 'export function registerToolPkg(): boolean { return true; }\n',
    'web/index.html': '<!doctype html><html><head><style>/* STARCOMPANION_STYLES */</style></head><body><script>/* STARCOMPANION_AUDIO_CORE */\n/* STARCOMPANION_APP */</script></body></html>',
    'web/styles.css': 'body{color:#123456}',
    'web/audio-core.mjs': 'export function normalize(value) { return value + 1; }\nglobalThis.StarVoiceAudio={normalize};',
    'web/app.js': '(function(){globalThis.fixtureResult=globalThis.StarVoiceAudio.normalize(41);})();',
  };
  for (const [name, content] of Object.entries(inputs)) { await mkdir(path.dirname(path.join(folder, name)), { recursive: true }); await writeFile(path.join(folder, name), content); }
  return folder;
}

test('real TypeScript/esbuild build produces loadable CJS and executable offline browser code', async t => {
  const folder = await fixture(t), result = await buildPlugin({ root: folder, source });
  const entries = verifyArchive(await readFile(result.output));
  assert.equal(result.verified, true);
  assert.equal(JSON.parse(entries.get('manifest.json')).toolpkg_id, 'com.skymoni.voice_calls');
  const module = { exports: {} };
  vm.runInNewContext(entries.get('dist/main.js').toString(), { module, exports: module.exports });
  assert.equal(module.exports.registerToolPkg(), true);
  const html = entries.get('resources/voice.html').toString();
  assert(!html.includes('STARCOMPANION_AUDIO_CORE'));
  assert(!html.includes('export function'));
  const context = vm.createContext({});
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
  assert.equal(context.fixtureResult, 42);
  for (const name of ['src/main.ts', 'web/audio-core.mjs', 'README.md', 'LICENSE']) assert(entries.has(name));
});

test('two builds ignore source mtimes and produce identical ZIP bytes and hashes', async t => {
  const folder = await fixture(t);
  const first = await buildPlugin({ root: folder, source, output: path.join(folder, 'dist/first.toolpkg') });
  await utimes(path.join(folder, 'src/main.ts'), new Date('2002-01-01'), new Date('2030-02-03'));
  const second = await buildPlugin({ root: folder, source, output: path.join(folder, 'dist/second.toolpkg') });
  assert.equal(first.sha256, second.sha256);
  assert.deepEqual(await readFile(first.output), await readFile(second.output));
});

test('ZIP verifier rejects changed payloads and headers', () => {
  const files = new Map([['manifest.json', Buffer.from('{"real":true}')], ['src/main.ts', Buffer.from('export const value=1;')]]);
  const zip = createArchive(files);
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  verifyArchive(zip, files);
  const payload = Buffer.from(zip); payload[30 + Buffer.byteLength('manifest.json')] ^= 1;
  assert.throws(() => verifyArchive(payload, files));
  const header = Buffer.from(zip); header.writeUInt32LE(123, 14);
  assert.throws(() => verifyArchive(header, files), /header mismatch/);
});

test('archive creation rejects traversal, private files, recordings and duplicate case paths', () => {
  for (const name of ['../escape', '/root', 'E:/key', 'src/.env', 'web/private.key', 'tests/run.log', 'resources/user.wav']) assert.throws(() => createArchive(new Map([[name, Buffer.from('x')]])));
  assert.throws(() => createArchive(new Map([['README.md', Buffer.from('a')], ['readme.md', Buffer.from('b')]])), /Duplicate/);
});

test('build rejects credential material in an otherwise allowed source directory', async t => {
  const folder = await fixture(t);
  await writeFile(path.join(folder, 'web/private.pem'), 'not a real credential');
  await assert.rejects(buildPlugin({ root: folder, source }), /forbidden/);
});

test('build fails if a manifest resource is missing', async t => {
  const folder = await fixture(t), filename = path.join(folder, 'manifest.json');
  const manifest = JSON.parse(await readFile(filename));
  manifest.resources.push({ key: 'missing', path: 'resources/missing.html', mime: 'text/html' });
  await writeFile(filename, JSON.stringify(manifest));
  await assert.rejects(buildPlugin({ root: folder, source }), /Declared resource is missing/);
});

test('HTML inliner rejects missing markers and imported browser dependencies', () => {
  const files = new Map([['web/index.html', Buffer.from('<style>/* STARCOMPANION_STYLES */</style><script>/* STARCOMPANION_AUDIO_CORE */\n/* STARCOMPANION_APP */</script>')], ['web/styles.css', Buffer.from('body{}')], ['web/audio-core.mjs', Buffer.from('export const value=1;')], ['web/app.js', Buffer.from('(function(){})();')]]);
  inlineDocument(files);
  const missing = new Map(files); missing.set('web/index.html', Buffer.from('<html></html>'));
  assert.throws(() => inlineDocument(missing), /Audio core/);
  const imported = new Map(files); imported.set('web/app.js', Buffer.from("import './remote.js';"));
  assert.throws(() => inlineDocument(imported), /module imports/);
  imported.set('web/app.js', Buffer.from("(function(){return import('remote');})();"));
  assert.throws(() => inlineDocument(imported), /module imports/);
  const remote = new Map(files); remote.set('web/index.html', Buffer.from(files.get('web/index.html').toString() + '<script src=https://example.test/code.js></script>'));
  assert.throws(() => inlineDocument(remote), /external resources/);
});

async function uiModule(filename, toolpkg = {}, tools = {}) {
  const { esbuild } = loadTools(source, root);
  const result = await esbuild.build({ absWorkingDir: root, entryPoints: [filename], bundle: true, format: 'cjs', platform: 'neutral', write: false, logLevel: 'silent' });
  const module = { exports: {} };
  vm.runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, ToolPkg: toolpkg, Tools: tools, setTimeout, clearTimeout });
  return module.exports.default;
}

function uiContext(initial = {}) {
  const state = new Map(Object.entries(initial)), refs = new Map(), cleanup = new Map(), interfaces = new Map(), evaluations = [];
  const controller = { addJavascriptInterface: (name, value) => interfaces.set(name, value), evaluateJavascript: async code => { evaluations.push(code); } };
  const ctx = {
    UI: new Proxy({}, { get: (_target, type) => (props, children = []) => ({ type, props, children }) }),
    MaterialTheme: { colorScheme: { primary: '#000', onSurfaceVariant: '#333', error: '#900' } },
    useState: (key, value) => { if (!state.has(key)) state.set(key, value); return [state.get(key), next => state.set(key, next)]; },
    useRef: (key, value) => { if (!refs.has(key)) refs.set(key, { current: value }); return refs.get(key); },
    useEffect: (key, effect) => { if (!cleanup.has(key)) cleanup.set(key, effect()); },
    createWebViewController: () => controller,
  };
  return { ctx, refs, interfaces, evaluations, dispose: () => { for (const fn of cleanup.values()) fn?.(); } };
}

function nativeTools(overrides = {}) {
  const calls = { chats: [], replies: [], cancels: [] };
  const tools = {
    Chat: {
      listChats: async params => { calls.chats.push(params); return { currentChatId: 'unrelated-current-chat', chats: [{ id: 'pinned-chat', title: 'Pinned character', isCurrent: false }] }; },
      sendMessage: async request => { calls.replies.push(request); return { chatId: 'pinned-chat', aiResponse: 'A real completed fixture reply', outcome: { type: 'committed', status: 'completed', userMessageTimestamp: 10, assistant: { messageTimestamp: 20 } } }; },
      sendMessageStreaming: () => { throw new Error('The page must use the canonical receipt, never the observer.'); },
      cancel: async id => { calls.cancels.push(id); return { chatId: id, cancelRequested: false }; },
      ...overrides,
    },
    Tts: { listConfigs: async () => ({ configs: [] }), getCurrentConfigId: async () => ({ configId: '' }) },
  };
  return { calls, tools };
}

test('actual menu carries the selected chat and screen honors the nested WebView ABI', async () => {
  const menu = await uiModule('src/ui/menu.ts'), selected = uiContext({ chatId: 'pinned-chat' });
  assert.equal(menu(selected.ctx).props.onClick().input.chatId, 'pinned-chat');
  assert.equal(menu(uiContext().ctx).props.onClick().input.chatId, null);
  const { calls, tools } = nativeTools(), screen = await uiModule('src/ui/screen.ts', { readResource: async () => '/voice.html' }, tools);
  const harness = uiContext({ presentation: { requestId: 'presentation-7', input: { chatId: 'pinned-chat' } }, chatId: 'unrelated-current-chat' });
  const tree = screen(harness.ctx); await tree.props.onLoad();
  const bridge = harness.interfaces.get('StarVoice');
  assert(bridge);
  assert.equal((await bridge.request([{ op: 'bootstrap' }])).ok, false);
  assert.equal((await bridge.request([[{ op: 'bootstrap' }]])).ok, true);
  assert(calls.chats.some(query => query.chat_ids?.[0] === 'pinned-chat' && query.limit === 1));
  const footer = tree.children[1].children.find(node => node.type === 'Button');
  const close = await footer.props.onClick();
  assert.equal(close.type, 'toolpkg.presentation.cancel');
  assert.equal(close.requestId, 'presentation-7');
  assert(harness.evaluations.some(code => code.includes('hangup')));
});

test('actual screen keeps its real service state across separate open, reply and poll callbacks', async () => {
  const { calls, tools } = nativeTools();
  const screen = await uiModule('src/ui/screen.ts', { readResource: async () => '/voice.html' }, tools);
  const harness = uiContext({ presentation: { requestId: 'presentation-real-service', input: { chatId: 'pinned-chat' } } });
  const tree = screen(harness.ctx); await tree.props.onLoad();
  const request = harness.interfaces.get('StarVoice').request;
  const opened = await request([[{ op: 'open', callId: 'retained-call', chatId: 'pinned-chat' }]]);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  const rerendered = screen(harness.ctx); await rerendered.props.onLoad();
  const nextRequest = harness.interfaces.get('StarVoice').request;
  const replied = await nextRequest([[{ op: 'reply', callId: 'retained-call', turnId: 'turn-1', text: 'hello' }]]);
  assert.equal(replied.ok, true, JSON.stringify(replied));
  const polled = await nextRequest([[{ op: 'poll', callId: 'retained-call' }]]);
  assert.equal(polled.ok, true, JSON.stringify(polled));
  assert.equal(polled.value.turn.replyText, 'A real completed fixture reply');
  assert.equal(calls.replies.length, 1);
  assert.equal(calls.replies[0].chatId, 'pinned-chat');
  assert.equal(calls.replies[0].runtime, 'main');
  await request([[{ op: 'close', callId: 'retained-call' }]]);
});

test('actual screen rejects a different chat before invoking or tracking its service', async () => {
  const { calls, tools } = nativeTools();
  const screen = await uiModule('src/ui/screen.ts', { readResource: async () => '/voice.html' }, tools);
  const harness = uiContext({ presentation: { requestId: 'presentation-owned-chat', input: { chatId: 'pinned-chat' } } });
  const tree = screen(harness.ctx); await tree.props.onLoad();
  const service = harness.refs.get('voice-service').current;
  const receive = service.receive, observed = [];
  service.receive = payload => { observed.push(payload); return receive(payload); };
  const request = harness.interfaces.get('StarVoice').request;
  const rejected = await request([[{ op: 'open', callId: 'wrong-chat', chatId: 'other-chat' }]]);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, 'CALL_CHAT_MISMATCH');
  assert.deepEqual(observed, []);
  assert.deepEqual(calls.chats, []);
  const close = await request([[{ op: 'close', callId: 'wrong-chat' }]]);
  assert.equal(close.error.code, 'CALL_NOT_OWNED');
  assert.deepEqual(observed, []);
  const opened = await request([[{ op: 'open', callId: 'correct-chat', chatId: 'pinned-chat' }]]);
  assert.equal(opened.ok, true, JSON.stringify(opened));
  await request([[{ op: 'close', callId: 'correct-chat' }]]);
});

test('actual screen closes an open that resolves after its route is disposed', async () => {
  let resolveOpen;
  const pending = new Promise(resolve => { resolveOpen = resolve; });
  let first = true;
  const { tools } = nativeTools({ listChats: async () => { if (first) { first = false; return pending; } return { currentChatId: null, chats: [{ id: 'pinned-chat', title: 'Pinned character', isCurrent: false }] }; } });
  const screen = await uiModule('src/ui/screen.ts', { readResource: async () => '/voice.html' }, tools);
  const harness = uiContext({ presentation: { requestId: 'presentation-8', input: { chatId: 'pinned-chat' } } });
  const tree = screen(harness.ctx); await tree.props.onLoad();
  const actualService = harness.refs.get('voice-service').current;
  const actualReceive = actualService.receive;
  const observedRequests = [];
  actualService.receive = payload => { observedRequests.push(payload); return actualReceive(payload); };
  const opening = harness.interfaces.get('StarVoice').request([[{ op: 'open', callId: 'owned-call', chatId: 'pinned-chat' }]]);
  harness.dispose();
  assert(observedRequests.some(request => request.op === 'close' && request.callId === 'owned-call'), 'route disposal must send close before returning, even while open is pending');
  resolveOpen({ currentChatId: null, chats: [{ id: 'pinned-chat', title: 'Pinned character', isCurrent: false }] });
  const response = await opening;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'UI_CLOSED');
  const next = uiContext({ presentation: { requestId: 'presentation-next', input: { chatId: 'pinned-chat' } } });
  const nextTree = screen(next.ctx); await nextTree.props.onLoad();
  const nextBridge = next.interfaces.get('StarVoice');
  const reopened = await nextBridge.request([[{ op: 'open', callId: 'new-owned-call', chatId: 'pinned-chat' }]]);
  assert.equal(reopened.ok, true, JSON.stringify(reopened));
  await nextBridge.request([[{ op: 'close', callId: 'new-owned-call' }]]);
});
