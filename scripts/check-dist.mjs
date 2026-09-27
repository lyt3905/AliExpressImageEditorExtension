/**
 * Post-build guard for dist/.
 *
 * Exists because a half-finished build once reached Chrome: `emptyOutDir` had
 * wiped dist, the build was interrupted before the later steps ran, and the
 * extension shipped with `content-script.js` missing. Chrome then reported
 * "无法为脚本加载 JavaScript 'content-script.js'" — a confusing symptom with a
 * build-side cause.
 *
 * Run:  node scripts/check-dist.mjs
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = resolve(rootDir, 'dist');

const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function checkFile(relativePath, label) {
  if (!relativePath) return false;
  const absolute = join(distDir, relativePath);
  if (!existsSync(absolute)) {
    fail(`${label}: 缺失 ${relativePath}`);
    return false;
  }
  if (statSync(absolute).size === 0) {
    fail(`${label}: ${relativePath} 是空文件`);
    return false;
  }
  return true;
}

if (!existsSync(distDir)) {
  console.error('[check-dist] dist/ 不存在，请先执行 npm run build');
  process.exit(1);
}

// ---- manifest ----
const manifestPath = join(distDir, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('[check-dist] dist/manifest.json 缺失 —— 这会让 Chrome 报「清单文件丢失或不可读取」');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`[check-dist] dist/manifest.json 不是合法 JSON：${error.message}`);
  process.exit(1);
}

checkFile(manifest.background?.service_worker, 'background.service_worker');

for (const [index, script] of (manifest.content_scripts ?? []).entries()) {
  for (const file of script.js ?? []) checkFile(file, `content_scripts[${index}].js`);
  for (const file of script.css ?? []) checkFile(file, `content_scripts[${index}].css`);
}

checkFile(manifest.options_page, 'options_page');
checkFile(manifest.action?.default_popup, 'action.default_popup');

for (const [size, file] of Object.entries(manifest.icons ?? {})) checkFile(file, `icons[${size}]`);
for (const [size, file] of Object.entries(manifest.action?.default_icon ?? {})) {
  checkFile(file, `action.default_icon[${size}]`);
}

for (const [size, file] of Object.entries(manifest.icons ?? {})) {
  if (file && existsSync(join(distDir, file)) && !/^icons\//.test(file)) {
    notes.push(`icons[${size}] 不在 icons/ 目录下：${file}`);
  }
}

// ---- extension pages: local asset references must resolve ----
// `editor/index.html` is not listed in the manifest; the service worker opens it
// via chrome.runtime.getURL('editor/index.html?session=…').
const pages = [manifest.options_page, 'editor/index.html'].filter(Boolean);

for (const page of pages) {
  const absolute = join(distDir, page);
  if (!existsSync(absolute)) {
    fail(`页面缺失：${page}`);
    continue;
  }
  const html = readFileSync(absolute, 'utf8');
  const baseDir = dirname(absolute);
  // Relative refs resolve against the HTML file's OWN directory, not dist/.
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((url) => !/^(?:https?:|data:|chrome-extension:|#)/.test(url));

  for (const ref of refs) {
    if (!existsSync(resolve(baseDir, ref))) fail(`${page}: 引用的资源缺失 ${ref}`);
  }
}

// ---- content scripts must be classic scripts (no ESM) ----
for (const file of (manifest.content_scripts ?? []).flatMap((script) => script.js ?? [])) {
  const absolute = join(distDir, file);
  if (!existsSync(absolute)) continue;
  const source = readFileSync(absolute, 'utf8');

  if (/^\s*(?:import|export)\s/m.test(source)) {
    fail(`${file}: 含顶层 import/export —— 内容脚本不能是 ES module`);
    continue;
  }
  if (/[^\w.$]import\s*\(/.test(source)) {
    fail(`${file}: 含动态 import() —— 内容脚本中不可靠`);
    continue;
  }
  try {
    new vm.Script(source, { filename: file });
  } catch (error) {
    fail(`${file}: 无法作为经典脚本解析 —— ${error.message}`);
  }
}

// ---- service worker must be parseable ESM ----
const swFile = manifest.background?.service_worker;
if (swFile && existsSync(join(distDir, swFile))) {
  const source = readFileSync(join(distDir, swFile), 'utf8');
  if (/\brequire\s*\(/.test(source)) fail(`${swFile}: 含 require() —— MV3 service worker 不支持 CommonJS`);
}

// ---- report ----
if (notes.length > 0) {
  for (const note of notes) console.log(`[check-dist] 提示：${note}`);
}

if (problems.length > 0) {
  console.error('');
  console.error('[check-dist] 构建产物校验失败：');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('');
  console.error('dist/ 很可能是一次被中断的构建留下的半成品。请重新执行 npm run build。');
  process.exit(1);
}

const entryCount = manifest.icons ? Object.keys(manifest.icons).length : 0;
console.log(
  `[check-dist] PASS — manifest 引用完整（icons ${entryCount} 尺寸），` +
    '内容脚本为合法经典脚本，页面资源均可解析。',
);
