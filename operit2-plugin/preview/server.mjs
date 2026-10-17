// Design preview only. SPDX-License-Identifier: MIT
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const inputs = ['web/index.html', 'web/styles.css', 'web/audio-core.mjs', 'web/app.js',
  'preview/index.html', 'preview/preview.css', 'preview/workbench.js', 'preview/adapter.js'];
const assets = new Map([
  ['/', ['preview/index.html', 'text/html']],
  ['/preview.css', ['preview/preview.css', 'text/css']],
  ['/workbench.js', ['preview/workbench.js', 'text/javascript']],
  ['/adapter.js', ['preview/adapter.js', 'text/javascript']],
]);

export function createPreviewServer({ root = defaultRoot } = {}) {
  return createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Permissions-Policy', 'microphone=(), camera=(), display-capture=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; media-src 'none'; frame-ancestors 'self'; form-action 'none'");
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    try {
      const route = new URL(request.url, 'http://127.0.0.1').pathname;
      if (route === '/version') {
        const files = await Promise.all(inputs.map(name => readFile(path.join(root, name))));
        const hash = createHash('sha256'); files.forEach(file => hash.update(file));
        response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ revision: hash.digest('hex') }));
      } else if (route === '/phone') {
        const [template, css, core, app] = await Promise.all(inputs.slice(0, 4).map(name => readFile(path.join(root, name), 'utf8')));
        const escapeScript = value => value.replace(/<\/script/gi, '<\\/script');
        const html = template
          .replace('/* STARCOMPANION_STYLES */', () => css)
          .replace('/* STARCOMPANION_AUDIO_CORE */', () => escapeScript(core.replace(/^export\s+/gm, '')))
          .replace('<script>/* STARCOMPANION_APP */</script>', () => `<script src="/adapter.js"></script><script>${escapeScript(app)}</script>`);
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(html);
      } else if (assets.has(route)) {
        const [name, type] = assets.get(route);
        response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }).end(await readFile(path.join(root, name)));
      } else response.writeHead(404).end('Not found');
    } catch {
      if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('预览文件读取失败，请检查工作区文件。');
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const port = args.length === 0 ? 18770 : args.length === 2 && args[0] === '--port' ? Number(args[1]) : NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    process.stderr.write('用法：node preview/server.mjs [--port 18770]\n'); process.exitCode = 1;
  } else {
    const server = createPreviewServer();
    server.on('error', error => { process.stderr.write(`预览启动失败：${error.code || 'SERVER_ERROR'}。可用 --port 指定其他端口。\n`); process.exitCode = 1; });
    server.listen(port, '127.0.0.1', () => process.stdout.write(`星伴设计预览：http://127.0.0.1:${port}\n修改界面文件后自动刷新。模拟数据，不启用麦克风、不连接模型、不打包。\n`));
  }
}
