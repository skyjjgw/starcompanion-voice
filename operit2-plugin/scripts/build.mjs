import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

export const pluginId = 'com.skymoni.voice_calls';
const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const generatedHtml = 'resources/voice.html';
const excludedDirectories = new Set(['.git', 'node_modules', '.cache', 'cache', 'build', 'coverage', 'test-results', 'playwright-report', 'recordings']);
const allowedExtensions = new Set(['.ts', '.js', '.mjs', '.cjs', '.json', '.html', '.css', '.md', '.txt', '.svg', '.png', '.jpg', '.jpeg', '.webp']);
const topFiles = ['manifest.json', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.txt', 'CHANGELOG.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.web.json'];

export function safeArchivePath(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').some(x => !x || x === '.' || x === '..')) throw new Error(`Unsafe package path: ${name}`);
  if (name.split('/').some(x => excludedDirectories.has(x)) || /(^|\/)(?:\.env(?:\..*)?|\.npmrc|local\.properties|credentials[^/]*|secrets?)(?:\/|$)/i.test(name) || /\.(?:pem|key|jks|keystore|p12|pfx|dpapi|db|sqlite\d*|log|tmp|wav|mp3|webm|apk|toolpkg)$/i.test(name)) throw new Error(`Private/cache/output file is forbidden: ${name}`);
  return name;
}

function operitRoot(root, override) {
  return path.resolve(override || process.env.OPERIT2_SOURCE || path.join(root, '../../starcompanion-operit2'));
}

/** Load installed build tools only; this function never installs dependencies. */
export function loadTools(sourceRoot, root = defaultRoot, toolsRoot = defaultRoot) {
  const require = createRequire(path.join(root, 'package.json'));
  function load(name) {
    const candidates = name === 'typescript' ? [path.join(sourceRoot, '.ci-tools/typescript/node_modules/typescript')] : [];
    candidates.push(path.join(root, 'node_modules', name), path.join(toolsRoot, 'node_modules', name), path.join(sourceRoot, 'plugins/packages/buildin/workflow/node_modules', name));
    for (const candidate of candidates) if (existsSync(path.join(candidate, 'package.json'))) return require(candidate);
    throw new Error(`Build dependency ${name} is unavailable. Run npm ci in this plugin or set OPERIT2_SOURCE to the existing Operit2 checkout.`);
  }
  return { ts: load('typescript'), esbuild: load('esbuild') };
}

async function walk(root, folder) {
  const directory = path.join(root, folder);
  if (!existsSync(directory)) return [];
  if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Package directory must not be a link: ${folder}`);
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${folder}/${entry.name}`;
    if (excludedDirectories.has(entry.name)) continue;
    const info = await lstat(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error(`Package input must not be a link: ${relative}`);
    if (info.isDirectory()) result.push(...await walk(root, relative));
    else if (info.isFile()) {
      safeArchivePath(relative);
      if (!allowedExtensions.has(path.extname(entry.name))) throw new Error(`Unexpected package input: ${relative}`);
      if (relative !== generatedHtml) result.push(relative);
    } else throw new Error(`Unsupported package input: ${relative}`);
  }
  return result.sort();
}

export async function captureInputs(root) {
  const names = [...topFiles.filter(name => existsSync(path.join(root, name)))];
  for (const folder of ['src', 'web', 'scripts', 'resources', 'tests', 'licenses']) names.push(...await walk(root, folder));
  const files = new Map();
  for (const name of names.sort()) {
    safeArchivePath(name);
    if ((await lstat(path.join(root, name))).isSymbolicLink()) throw new Error(`Package input must not be a link: ${name}`);
    files.set(name, await readFile(path.join(root, name)));
  }
  for (const name of ['manifest.json', 'src/main.ts', 'README.md', 'LICENSE', 'package.json', 'tsconfig.json', 'web/index.html', 'web/styles.css', 'web/app.js', 'web/audio-core.mjs']) if (!files.has(name)) throw new Error(`Required package input is missing: ${name}`);
  return files;
}

export function checkProject(root, sourceRoot, ts) {
  const configPath = path.join(root, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const options = { ...parsed.options, noEmit: true, baseUrl: root, paths: { '@operit/*': [path.join(sourceRoot, 'plugins/types/*')] } };
  const host = ts.createCompilerHost(options);
  host.resolveModuleNames = (names, containingFile) => names.map(name => {
    if (name.endsWith('.ui.js')) {
      const candidate = path.resolve(path.dirname(containingFile), name.replace(/\.ui\.js$/, '.ts'));
      if (ts.sys.fileExists(candidate)) return { resolvedFileName: candidate, extension: ts.Extension.Ts };
    }
    return ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
  });
  const globals = path.join(sourceRoot, 'plugins/types/index.d.ts');
  if (!existsSync(globals)) throw new Error(`Operit2 SDK types are missing: ${globals}`);
  const program = ts.createProgram([...parsed.fileNames, globals], options, host);
  const diagnostics = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)];
  if (diagnostics.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
}

export function inlineDocument(files) {
  let html = files.get('web/index.html').toString('utf8');
  let core = files.get('web/audio-core.mjs').toString('utf8');
  core = core.replace(/^(\s*)export\s+(?=(?:async\s+)?function\b|class\b|(?:const|let|var)\b)/gm, '$1');
  const app = files.get('web/app.js').toString('utf8');
  if (/^\s*(?:import|export)\b/m.test(core) || /^\s*(?:import|export)\b/m.test(app) || /\bimport\s*\(/.test(core + '\n' + app)) throw new Error('Browser scripts must have no module imports or remaining exports');
  new vm.Script(core, { filename: 'audio-core.js' });
  new vm.Script(app, { filename: 'app.js' });
  const replacements = {
    '/* STARCOMPANION_AUDIO_CORE */': core.replace(/<\/script/gi, '<\\/script'),
    '/* STARCOMPANION_APP */': app.replace(/<\/script/gi, '<\\/script'),
    '/* STARCOMPANION_STYLES */': files.get('web/styles.css').toString('utf8').replace(/<\/style/gi, '<\\/style'),
  };
  const corePosition = html.indexOf('/* STARCOMPANION_AUDIO_CORE */');
  if (corePosition < 0 || corePosition > html.indexOf('/* STARCOMPANION_APP */')) throw new Error('Audio core must be inlined before app.js');
  for (const [marker, content] of Object.entries(replacements)) {
    if (html.split(marker).length !== 2) throw new Error(`HTML must contain exactly one build marker: ${marker}`);
    html = html.replace(marker, () => content);
  }
  for (const tag of html.matchAll(/<(?:script|link|img|iframe|audio|video|source)\b[^>]*>/gi)) {
    for (const attribute of tag[0].matchAll(/\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      const value = attribute[1] ?? attribute[2] ?? attribute[3];
      if (value && !/^(?:data:|blob:|#)/i.test(value)) throw new Error('The packaged voice document must contain no external resources');
    }
  }
  if (/url\(\s*["']?https?:/i.test(html) || /@import\s/i.test(files.get('web/styles.css').toString())) throw new Error('The packaged voice document must contain no external resources');
  return Buffer.from(html, 'utf8');
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** ZIP32 with fixed DOS timestamp, sorted UTF-8 paths and no machine-specific metadata. */
export function createArchive(files) {
  const local = [], central = [], names = [...files.keys()].sort(), folded = new Set();
  if (names.length > 65535) throw new Error('ZIP32 entry limit exceeded');
  let offset = 0;
  for (const name of names) {
    safeArchivePath(name);
    if (folded.has(name.toLowerCase())) throw new Error(`Duplicate package path: ${name}`);
    folded.add(name.toLowerCase());
    const raw = Buffer.from(files.get(name)), compressed = deflateRawSync(raw, { level: 9 }), encoded = Buffer.from(name), crc = crc32(raw);
    if (raw.length > 0xffffffff || compressed.length > 0xffffffff || encoded.length > 65535) throw new Error('ZIP32 size limit exceeded');
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(raw.length, 22); header.writeUInt16LE(encoded.length, 26);
    local.push(header, encoded, compressed);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt16LE(33, 14);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(raw.length, 24); entry.writeUInt16LE(encoded.length, 28); entry.writeUInt32LE((0o100644 << 16) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, encoded); offset += header.length + encoded.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

/** Validate both ZIP headers and every decompressed entry CRC, length and source byte. */
export function verifyArchive(archive, expected) {
  const end = archive.length - 22;
  if (end < 0 || archive.readUInt32LE(end) !== 0x06054b50 || archive.readUInt16LE(end + 20) !== 0) throw new Error('Invalid ZIP end record');
  const count = archive.readUInt16LE(end + 10), start = archive.readUInt32LE(end + 16), size = archive.readUInt32LE(end + 12), result = new Map();
  if (archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0 || count !== archive.readUInt16LE(end + 8) || start + size !== end || (expected && count !== expected.size)) throw new Error('ZIP directory count/length mismatch');
  let position = start, nextLocal = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || archive.readUInt32LE(position) !== 0x02014b50) throw new Error('Invalid ZIP central header');
    const nameLength = archive.readUInt16LE(position + 28), extra = archive.readUInt16LE(position + 30), comment = archive.readUInt16LE(position + 32);
    const name = safeArchivePath(archive.subarray(position + 46, position + 46 + nameLength).toString('utf8'));
    const crc = archive.readUInt32LE(position + 16), compressed = archive.readUInt32LE(position + 20), rawLength = archive.readUInt32LE(position + 24), local = archive.readUInt32LE(position + 42);
    if (result.has(name) || extra || comment || local !== nextLocal || archive.readUInt16LE(position + 8) !== 0x800 || archive.readUInt16LE(position + 10) !== 8 || archive.readUInt16LE(position + 12) !== 0 || archive.readUInt16LE(position + 14) !== 33) throw new Error('ZIP path/order/metadata mismatch');
    if (archive.readUInt32LE(local) !== 0x04034b50 || archive.readUInt16LE(local + 6) !== 0x800 || archive.readUInt16LE(local + 8) !== 8 || archive.readUInt16LE(local + 10) !== 0 || archive.readUInt16LE(local + 12) !== 33 || archive.readUInt32LE(local + 14) !== crc || archive.readUInt32LE(local + 18) !== compressed || archive.readUInt32LE(local + 22) !== rawLength || archive.readUInt16LE(local + 26) !== nameLength || archive.readUInt16LE(local + 28) !== 0) throw new Error('ZIP local header mismatch');
    if (!archive.subarray(local + 30, local + 30 + nameLength).equals(Buffer.from(name))) throw new Error('ZIP local name mismatch');
    const dataStart = local + 30 + nameLength, dataEnd = dataStart + compressed;
    if (dataEnd > start) throw new Error('ZIP entry crosses central directory');
    const raw = inflateRawSync(archive.subarray(dataStart, dataEnd));
    if (raw.length !== rawLength || crc32(raw) !== crc || (expected && (!expected.has(name) || !raw.equals(Buffer.from(expected.get(name)))))) throw new Error(`ZIP entry CRC/content mismatch: ${name}`);
    result.set(name, raw); nextLocal = dataEnd; position += 46 + nameLength;
  }
  if (position !== end || nextLocal !== start || JSON.stringify([...result.keys()]) !== JSON.stringify([...result.keys()].sort())) throw new Error('ZIP directory order/size mismatch');
  return result;
}

export async function buildPlugin({ root = defaultRoot, source, output, checkOnly = false, toolsRoot = defaultRoot } = {}) {
  root = path.resolve(root);
  const sourceRoot = operitRoot(root, source), { ts, esbuild } = loadTools(sourceRoot, root, toolsRoot);
  checkProject(root, sourceRoot, ts);
  if (checkOnly) return { typecheck: 'passed' };
  const files = await captureInputs(root), manifest = JSON.parse(files.get('manifest.json').toString());
  if (manifest.toolpkg_id !== pluginId || manifest.api_version !== '2.0.0' || manifest.main !== 'dist/main.js' || manifest.version !== '0.1.0') throw new Error('Unexpected ToolPkg identity/API/main/version');
  const compile = async (entry, external = []) => {
    const result = await esbuild.build({ absWorkingDir: root, entryPoints: [entry], bundle: true, format: 'cjs', platform: 'neutral', target: 'es2020', supported: { 'async-await': false }, external, write: false, legalComments: 'inline', logLevel: 'silent' });
    if (result.outputFiles.length !== 1) throw new Error(`Expected one module: ${entry}`);
    return result.outputFiles[0].text;
  };
  const generated = new Map([['dist/main.js', Buffer.from(await compile('src/main.ts', ['./ui/*.ui.js']))], [generatedHtml, inlineDocument(files)]]);
  const ui = [...files.keys()].filter(name => /^src\/ui\/.*\.ts$/.test(name) && !name.endsWith('.d.ts'));
  if (ui.length) {
    const { compileComposeModule } = await import(pathToFileURL(path.join(sourceRoot, 'plugins/tools/compile_compose_module.mjs')).href);
    for (const entry of ui) {
      const outputPath = entry.replace(/^src\//, 'dist/').replace(/(?:\.ui)?\.ts$/, '.ui.js');
      generated.set(outputPath, Buffer.from(compileComposeModule(await compile(entry), `${pluginId}:${outputPath}`)));
    }
  }
  const entries = new Map([...files, ...generated]);
  if (!Array.isArray(manifest.resources) || !manifest.resources.some(r => r.path === generatedHtml)) throw new Error('Manifest must declare resources/voice.html');
  for (const resource of manifest.resources) if (!entries.has(safeArchivePath(resource.path)) || entries.get(resource.path).length === 0) throw new Error(`Declared resource is missing: ${resource.path}`);
  for (const item of manifest.subpackages ?? []) if (!entries.has(safeArchivePath(item.entry))) throw new Error(`Declared subpackage is missing: ${item.entry}`);
  if (manifest.public_api && !entries.has(safeArchivePath(manifest.public_api))) throw new Error('Declared public_api source is missing');
  const current = await captureInputs(root);
  if (files.size !== current.size || [...files].some(([name, bytes]) => !current.get(name)?.equals(bytes))) throw new Error('Plugin sources changed during build; retry after edits finish');
  const archive = createArchive(entries);
  verifyArchive(archive, entries);
  output = path.resolve(output || path.join(root, 'dist/StarCompanion-Voice-0.1.0.toolpkg'));
  for (const [name, bytes] of generated) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), bytes); }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, archive);
  verifyArchive(await readFile(output), entries);
  return { output, bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex'), entries: entries.size, verified: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    let output, checkOnly = false;
    for (let i = 2; i < process.argv.length; i++) {
      if (process.argv[i] === '--output' && process.argv[i + 1]) output = process.argv[++i];
      else if (process.argv[i] === '--check') checkOnly = true;
      else throw new Error(`Unknown or incomplete argument: ${process.argv[i]}`);
    }
    console.log(JSON.stringify(await buildPlugin({ output, checkOnly }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
