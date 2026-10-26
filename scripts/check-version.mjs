#!/usr/bin/env node
/**
 * One version, three places — this is the check that keeps them honest.
 *
 * A Chrome extension's version lives in `public/manifest.json` (Chrome rejects
 * anything that is not 1–4 dot-separated integers, no leading zeros). npm keeps
 * its own copy in `package.json`, and `package-lock.json` carries a third. They
 * drift silently: the build still succeeds, and the only symptom is an artifact
 * whose filename disagrees with the manifest the browser reads.
 *
 * Run in CI before the build, and locally via `npm run check:version`.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
  } catch (error) {
    console.error(`[check-version] 无法读取 ${relativePath}：${error.message}`);
    process.exit(1);
  }
}

const pkg = readJson('package.json');
const manifest = readJson('public/manifest.json');
const lock = readJson('package-lock.json');

const problems = [];

// Chrome's rule, not ours: 0-65535 per part, 1-4 parts, no leading zeros.
const CHROME_VERSION = /^(0|[1-9]\d{0,3})(\.(0|[1-9]\d{0,3})){0,3}$/;

if (typeof manifest.version !== 'string' || !manifest.version) {
  problems.push('public/manifest.json 缺少 version');
} else if (!CHROME_VERSION.test(manifest.version)) {
  problems.push(`manifest.json version 不符合 Chrome 格式：${manifest.version}`);
}
if (pkg.version !== manifest.version) {
  problems.push(`package.json ${pkg.version} ≠ manifest.json ${manifest.version}`);
}
// npm only rewrites the lock's root entry when it performs the bump itself.
if (lock.version !== undefined && lock.version !== manifest.version) {
  problems.push(`package-lock.json ${lock.version} ≠ manifest.json ${manifest.version}`);
}
if (lock.packages?.['']?.version !== undefined && lock.packages[''].version !== manifest.version) {
  problems.push(`package-lock.json packages[""] ${lock.packages[''].version} ≠ manifest.json ${manifest.version}`);
}

if (problems.length > 0) {
  console.error('[check-version] FAIL');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error('  → 先改 public/manifest.json，再 npm version <same> --no-git-tag-version');
  process.exit(1);
}

// `--plain` prints nothing but the number, for `$(...)` in CI or a shell script.
if (process.argv.includes('--plain')) {
  process.stdout.write(manifest.version);
} else {
  console.log(`[check-version] PASS ${manifest.version}`);
}
