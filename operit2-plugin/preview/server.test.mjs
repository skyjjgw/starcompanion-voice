import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPreviewServer } from './server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function start(t, folder = root) {
  const server = createPreviewServer({ root: folder });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

test('design preview serves shared UI and simulation, without SDK tools or file access', async t => {
  const url = await start(t);
  const workbench = await fetch(url);
  assert.equal(workbench.status, 200); assert.match(await workbench.text(), /设计预览/);
  const page = await fetch(url + '/phone'), html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get('permissions-policy'), /microphone=\(\)/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(html, /src="\/adapter.js"/);
  assert.ok(html.includes(await readFile(path.join(root, 'web/styles.css'), 'utf8')));
  assert.doesNotMatch(html, /STARCOMPANION_(APP|AUDIO_CORE|STYLES)/);
  assert.equal((await fetch(url + '/src/host-service.ts')).status, 404);
  assert.equal((await fetch(url + '/AGENTS.md')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});

test('editing a shared style changes both revision and next response without any build', async t => {
  const cache = path.resolve(root, '../../starcompanion-voice-build-cache');
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(path.join(cache, 'design-preview-'));
  t.after(async () => {
    if (!path.resolve(folder).startsWith(cache + path.sep)) throw new Error('Invalid preview fixture path');
    await rm(folder, { recursive: true, force: true });
  });
  for (const name of ['web/index.html', 'web/styles.css', 'web/audio-core.mjs', 'web/app.js', 'preview/index.html', 'preview/preview.css', 'preview/workbench.js', 'preview/adapter.js']) {
    await mkdir(path.dirname(path.join(folder, name)), { recursive: true });
    await writeFile(path.join(folder, name), await readFile(path.join(root, name)));
  }
  const url = await start(t, folder);
  const before = await (await fetch(url + '/version')).json();
  await writeFile(path.join(folder, 'web/styles.css'), 'body{background:rgb(7,23,41)}');
  const after = await (await fetch(url + '/version')).json();
  assert.notEqual(before.revision, after.revision);
  assert.match(await (await fetch(url + '/phone')).text(), /background:rgb\(7,23,41\)/);
});
