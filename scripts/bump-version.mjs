#!/usr/bin/env node
/**
 * One command to move the version — in all three places that matter.
 *
 * `npm version` only knows about `package.json` and the lockfile; Chrome reads
 * `public/manifest.json`. Bumping by hand is exactly how the three drift apart, and
 * the drift is invisible: the build passes, and the only symptom is an artifact
 * whose name disagrees with the manifest the browser loaded.
 *
 *   node scripts/bump-version.mjs patch      # 10.1.0 -> 10.1.1
 *   node scripts/bump-version.mjs minor      # 10.1.0 -> 10.2.0
 *   node scripts/bump-version.mjs major      # 10.1.0 -> 11.0.0
 *   node scripts/bump-version.mjs 10.2.3     # explicit, must be valid
 *
 * It writes, then re-reads and verifies. Nothing else (no git, no tags) — commit the
 * bump together with the change it belongs to.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isChromeVersion, nextVersion } from './version-math.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'public/manifest.json';
const PACKAGE = 'package.json';
const LOCK = 'package-lock.json';

/** Chrome's rule lives in version-math.mjs, together with the bump arithmetic. */

function fail(message) {
  console.error(`[bump-version] ${message}`);
  process.exit(1);
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(resolve(root, relativePath), 'utf8'));
}

function writeJson(relativePath, value) {
  writeFileSync(resolve(root, relativePath), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const argument = (process.argv[2] ?? '').trim();
if (!argument) fail('用法：node scripts/bump-version.mjs <patch|minor|major|X.Y.Z>');

const manifest = readJson(MANIFEST);
const current = manifest.version;
if (typeof current !== 'string' || !isChromeVersion(current)) {
  fail(`当前 manifest version 不合法：${current}`);
}

let next;
try {
  next = nextVersion(current, argument);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

manifest.version = next;
writeJson(MANIFEST, manifest);

const pkg = readJson(PACKAGE);
pkg.version = next;
writeJson(PACKAGE, pkg);

const lock = readJson(LOCK);
lock.version = next;
if (lock.packages && typeof lock.packages === 'object' && lock.packages['']) {
  lock.packages[''].version = next;
}
writeJson(LOCK, lock);

// Read everything back instead of trusting the writes.
const written = [MANIFEST, PACKAGE, LOCK].map((path) => readJson(path).version);
const lockRoot = readJson(LOCK).packages?.['']?.version;
if (written.some((version) => version !== next) || (lockRoot !== undefined && lockRoot !== next)) {
  fail(`写入后校验失败：${JSON.stringify({ manifest: written[0], package: written[1], lock: written[2], lockRoot })}`);
}

console.log(`[bump-version] ${current} -> ${next}（manifest / package / lock 已同步）`);
console.log('[bump-version] 记得把这次改动和它放进同一个提交，然后 npm run check:version');
