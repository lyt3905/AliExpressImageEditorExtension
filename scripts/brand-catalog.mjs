#!/usr/bin/env node
/**
 * Brand catalog maintenance — `catalog/brands.json` is a published contract.
 *
 * The extension reads that file straight from GitHub with no build step, so the
 * file IS the API: a typo'd path or a stale checksum ships instantly to every
 * installed copy. This script is what stops that:
 *
 *   node scripts/brand-catalog.mjs            # validate (same as --check)
 *   node scripts/brand-catalog.mjs --write    # recompute sha256, normalise, updatedAt
 *   node scripts/brand-catalog.mjs --bump     # version + 1, then --write
 *
 * `--bump` is deliberately explicit: `version` is the extension's "did anything
 * change upstream?" signal, so it must move when (and only when) the catalog
 * changes. `npm run catalog:check` / `catalog:write` / `catalog:bump` wire the
 * three modes up.
 *
 * Files are hashed from `catalog/` itself, so a logo referenced but not committed
 * fails here rather than in a seller's browser.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalogDir = resolve(root, 'catalog');
const manifestPath = resolve(catalogDir, 'brands.json');

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LOGO_FILE = /^logos\/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BRANDS = 100;
const MAX_NAME = 120;
const MAX_TERM = 60;
const MAX_TERMS = 40;
const MAX_LOGO_BYTES = 4 * 1024 * 1024;

const mode = process.argv.includes('--bump')
  ? 'bump'
  : process.argv.includes('--write')
    ? 'write'
    : 'check';

if (!existsSync(manifestPath)) {
  console.error(`[brand-catalog] 找不到 ${manifestPath}`);
  process.exit(1);
}

/** Errors abort; warnings only print (a missing checksum is fine while drafting). */
const problems = [];
const notes = [];

function fail(message) {
  problems.push(message);
}

function note(message) {
  notes.push(message);
}

let raw;
try {
  raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (error) {
  console.error(`[brand-catalog] brands.json 不是合法 JSON：${error.message}`);
  process.exit(1);
}

if (!Number.isInteger(raw.version) || raw.version < 1) {
  fail('version 必须是 ≥1 的整数');
}
if (raw.updatedAt !== undefined && typeof raw.updatedAt !== 'string') {
  fail('updatedAt 必须是字符串（建议 YYYY-MM-DD）');
}
if (!Array.isArray(raw.brands) || raw.brands.length === 0) {
  fail('brands 必须是非空数组');
} else if (raw.brands.length > MAX_BRANDS) {
  fail(`品牌数量 ${raw.brands.length} 超过上限 ${MAX_BRANDS}`);
}

const seen = new Set();
const brands = Array.isArray(raw.brands) ? raw.brands : [];

for (const [index, brand] of brands.entries()) {
  const at = `brands[${index}]`;
  if (!brand || typeof brand !== 'object') {
    fail(`${at} 不是对象`);
    continue;
  }
  if (typeof brand.id !== 'string' || !SLUG.test(brand.id)) {
    fail(`${at}.id 必须是 a-z0-9- 的 slug（最多 64 字符）：${String(brand.id)}`);
  } else if (seen.has(brand.id)) {
    fail(`${at}.id 重复：${brand.id}`);
  } else {
    seen.add(brand.id);
  }
  if (typeof brand.name !== 'string' || brand.name.trim() === '') {
    fail(`${at}.name 不能为空`);
  } else if (brand.name.length > MAX_NAME) {
    fail(`${at}.name 超过 ${MAX_NAME} 字符`);
  }
  if (brand.aliases !== undefined) {
    note(
      `${at}.aliases 已废弃（10.10.0 起每条只保留 name + keywords）；扩展仍会把它的内容当关键词读，但请直接写进 keywords`,
    );
  }
  for (const field of ['keywords']) {
    const list = brand[field];
    if (list === undefined) {
      note(`${at}.${field} 缺失，按空数组处理`);
      continue;
    }
    if (!Array.isArray(list)) {
      fail(`${at}.${field} 必须是字符串数组`);
      continue;
    }
    if (list.length > MAX_TERMS) fail(`${at}.${field} 超过 ${MAX_TERMS} 项`);
    for (const term of list) {
      if (typeof term !== 'string' || term.trim() === '') {
        fail(`${at}.${field} 含空项`);
      } else if (term.length > MAX_TERM) {
        fail(`${at}.${field} 的「${term}」超过 ${MAX_TERM} 字符`);
      }
    }
  }
  if (brand.rev !== undefined && typeof brand.rev !== 'string') {
    fail(`${at}.rev 必须是字符串`);
  }
  const logo = brand.logo;
  if (!logo || typeof logo !== 'object') {
    fail(`${at}.logo 缺失`);
    continue;
  }
  if (typeof logo.file !== 'string' || !LOGO_FILE.test(logo.file)) {
    fail(`${at}.logo.file 必须是 logos/<name>.png|jpg|jpeg|webp（小写）：${String(logo.file)}`);
    continue;
  }
  if (logo.sha256 !== undefined && !SHA256.test(logo.sha256)) {
    fail(`${at}.logo.sha256 必须是 64 位小写十六进制`);
  }
  const logoPath = resolve(catalogDir, logo.file);
  if (!existsSync(logoPath)) {
    fail(`${at}.logo.file 指向的文件不存在：${logo.file}`);
    continue;
  }
  const bytes = readFileSync(logoPath);
  if (bytes.length === 0) {
    fail(`${at}.logo.file 是空文件：${logo.file}`);
    continue;
  }
  if (bytes.length > MAX_LOGO_BYTES) {
    fail(`${at}.logo.file 超过 4MB：${logo.file}`);
  }
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (logo.sha256 === undefined) {
    if (mode === 'check') note(`${at}.logo.sha256 缺失（--write 会补上）`);
    logo.sha256 = actual;
  } else if (logo.sha256 !== actual) {
    if (mode === 'check') {
      fail(`${at}.logo.sha256 与实际文件不符：${logo.file}（实际 ${actual.slice(0, 12)}…）`);
    } else {
      note(`更新 ${logo.file} 的 sha256`);
      logo.sha256 = actual;
    }
  }
}

if (problems.length > 0) {
  console.error('[brand-catalog] FAIL');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

if (mode === 'check') {
  for (const message of notes) console.warn(`[brand-catalog] ${message}`);
  console.log(`[brand-catalog] PASS v${raw.version}，${brands.length} 个品牌`);
  process.exit(0);
}

if (mode === 'bump') {
  raw.version = (Number.isInteger(raw.version) ? raw.version : 0) + 1;
  console.log(`[brand-catalog] version → ${raw.version}（记得让扩展收到新版本）`);
}
raw.updatedAt = new Date().toISOString().slice(0, 10);
brands.sort((left, right) => String(left?.id).localeCompare(String(right?.id)));

writeFileSync(manifestPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
for (const message of notes) console.log(`[brand-catalog] ${message}`);
console.log(`[brand-catalog] 已写入 catalog/brands.json（v${raw.version}，${brands.length} 个品牌）`);
