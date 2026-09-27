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
/**
 * Classic-script check, shared by content scripts and the page-fill assets:
 * neither `manifest.content_scripts.js` nor `executeScript({ files })` accepts
 * an ES module.
 */
function checkClassicScript(relativePath, label) {
  const absolute = join(distDir, relativePath);
  if (!existsSync(absolute)) return;
  const source = readFileSync(absolute, 'utf8');

  if (/^\s*(?:import|export)\s/m.test(source)) {
    fail(`${label} ${relativePath}: 含顶层 import/export —— 必须是经典脚本`);
    return;
  }
  if (/[^\w.$]import\s*\(/.test(source)) {
    fail(`${label} ${relativePath}: 含动态 import() —— 经典脚本中不可靠`);
    return;
  }
  try {
    new vm.Script(source, { filename: relativePath });
  } catch (error) {
    fail(`${label} ${relativePath}: 无法作为经典脚本解析 —— ${error.message}`);
  }
}

for (const file of (manifest.content_scripts ?? []).flatMap((script) => script.js ?? [])) {
  checkClassicScript(file, '内容脚本');
}

// ---- service worker must be parseable ESM ----
const swFile = manifest.background?.service_worker;
if (swFile && existsSync(join(distDir, swFile))) {
  const source = readFileSync(join(distDir, swFile), 'utf8');
  if (/\brequire\s*\(/.test(source)) fail(`${swFile}: 含 require() —— MV3 service worker 不支持 CommonJS`);
}

// ---- page-fill assets injected at runtime ----
// These are referenced NOWHERE in the manifest or in any HTML: the service
// worker injects them with `chrome.scripting.executeScript({ files })`. Nothing
// else would notice them going missing, and the only symptom would be
// 「回填脚本无响应」 at runtime — the same build-side cause / load-side symptom
// shape this whole script exists for.
//
// The list is read out of the runtime source rather than copied, so it cannot
// drift; the parse itself is asserted so a refactor cannot silently disable it.
const fillerSource = readFileSync(join(rootDir, 'src/background/page-filler.ts'), 'utf8');
const bridgeFilesMatch = /const BRIDGE_FILES: readonly string\[\] = \[([\s\S]*?)\]/.exec(fillerSource);

if (!bridgeFilesMatch) {
  fail('无法从 src/background/page-filler.ts 解析 BRIDGE_FILES —— 该校验已失效，请同步更新本脚本');
} else {
  const pageFillFiles = [...bridgeFilesMatch[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
  if (pageFillFiles.length === 0) {
    fail('BRIDGE_FILES 为空 —— 页面回填流程将没有脚本可注入');
  }
  let pageFillMissing = 0;
  for (const file of pageFillFiles) {
    // Order is load-bearing (each file reads its siblings at load time), and
    // existence is checked in list order so a missing middle file is obvious.
    if (!checkFile(file, '页面回填脚本')) {
      pageFillMissing += 1;
      continue;
    }
    checkClassicScript(file, '页面回填脚本');
  }
  // Only claim completeness when it is true — a "7 个齐备" note printed next to
  // a missing-file problem would send whoever reads it looking in the wrong place.
  if (pageFillMissing === 0) {
    notes.push(`页面回填注入脚本 ${pageFillFiles.length} 个齐备：${pageFillFiles.join(' → ')}`);
  }
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
