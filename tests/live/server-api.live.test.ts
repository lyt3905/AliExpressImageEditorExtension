/**
 * LIVE contract test against the real Toy Item Prod server.
 *
 * Skipped unless explicitly enabled, so `npm run test` never touches the network:
 *
 *   AIEE_LIVE=1 AIEE_USERNAME=admin AIEE_PASSWORD=<pw> npm run test:live
 *
 * It exercises the REAL `ServerApi` against the REAL endpoints. It is the only
 * check that would have caught the flat-vs-enveloped response mismatch, because
 * unit tests can only assert the shape they were told to expect.
 *
 * Read-only with respect to the product catalogue: it logs in, uploads one
 * generated PNG and runs background removal. It never touches AliExpress data.
 */

import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { messageOf } from '../../src/shared/errors';
import { ServerApi } from '../../src/services/server-api';
import type { FetchLike } from '../../src/services/server-api';

const LIVE = process.env.AIEE_LIVE === '1';
const BASE_URL = process.env.AIEE_SERVER_URL ?? 'https://39.107.244.239';
const USERNAME = process.env.AIEE_USERNAME ?? '';
const PASSWORD = process.env.AIEE_PASSWORD ?? '';
const READY = LIVE && Boolean(USERNAME) && Boolean(PASSWORD);

const TIMEOUT_MS = 90_000;

/**
 * Node has no cookie jar, so `credentials: 'include'` is a no-op here. This
 * wrapper replays the Set-Cookie values as a Cookie header, which is what
 * Chromium does for us inside the extension.
 */
function cookieJarFetch(): FetchLike {
  let cookie = '';
  return async (input, init) => {
    const headers = new Headers(init?.headers ?? {});
    if (cookie) headers.set('Cookie', cookie);
    const response = await fetch(input, { ...init, headers });
    const setCookies =
      typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (setCookies.length > 0) cookie = setCookies.map((value) => value.split(';')[0]).join('; ');
    return response;
  };
}

/**
 * A real PNG from the repo. Copied into an `ArrayBuffer`-backed view so it is
 * accepted as a `BlobPart` (a `Buffer` is typed as `Uint8Array<ArrayBufferLike>`).
 */
function fixturePng() {
  const source = readFileSync(new URL('../../public/icons/icon128.png', import.meta.url));
  const bytes = new Uint8Array(new ArrayBuffer(source.length));
  bytes.set(source);
  return bytes;
}

// ---------------------------------------------------------------- tiny PNG encoder
// Only used to produce N DISTINCT valid images for the concurrency probe above.

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(payload, 8);
  view.setUint32(8 + payload.length, crc32(out.subarray(4, 8 + payload.length)));
  return out;
}

/** A `size` x `size` solid-colour truecolour PNG. */
// NOTE: no explicit return annotation — `Uint8Array<ArrayBuffer>` must survive
// inference, otherwise it is not assignable to `BlobPart`.
function solidPng(size: number, rgb: [number, number, number]) {
  const ihdr = new Uint8Array(13);
  const header = new DataView(ihdr.buffer);
  header.setUint32(0, size);
  header.setUint32(4, size);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour

  const stride = size * 3 + 1;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y += 1) {
    const row = y * stride;
    raw[row] = 0; // filter type: none
    for (let x = 0; x < size; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }

  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe.skipIf(!READY)('live server contract', () => {
  it(
    'logs in, uploads a PNG, removes its background and fetches the result',
    async () => {
      const api = new ServerApi(BASE_URL, cookieJarFetch());

      const user = await api.login(USERNAME, PASSWORD);
      expect(user.username).toBe(USERNAME);
      expect(await api.currentUser()).not.toBeNull();

      const uploadedUrl = await api.uploadImage(new Blob([fixturePng()], { type: 'image/png' }), 'live-check.png');
      expect(uploadedUrl).toMatch(/^https?:\/\//);

      // The regression this file exists for: the live endpoint answers with a
      // FLAT {job, asset} body, and reading `data.asset.url` used to lose it.
      const resultUrl = await api.removeBackground(uploadedUrl);
      expect(resultUrl).toMatch(/^https?:\/\//);

      const blob = await api.fetchImageBlob(resultUrl);
      expect(blob.size).toBeGreaterThan(0);

      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    },
    TIMEOUT_MS,
  );

  /**
   * `CUTOUT_CONCURRENCY` is 6, but nobody knew whether the worker pool behind
   * the endpoint can actually absorb 6 simultaneous jobs. This measures it with
   * 6 DISTINCT images (identical bytes might be deduplicated server-side and
   * would understate the load).
   */
  it(
    'survives 6 concurrent upload + background-removal jobs',
    async () => {
      const api = new ServerApi(BASE_URL, cookieJarFetch());
      await api.login(USERNAME, PASSWORD);

      const count = 6;
      const images = Array.from({ length: count }, (_, index) =>
        solidPng(96, [index * 40, 255 - index * 30, 128 + index * 10]),
      );
      // Guard the hand-rolled encoder before blaming the server.
      for (const bytes of images) {
        expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      }

      const startedAll = Date.now();
      const results = await Promise.all(
        images.map(async (bytes, index) => {
          const started = Date.now();
          try {
            const url = await api.uploadImage(
              new Blob([bytes], { type: 'image/png' }),
              `concurrency-${index + 1}.png`,
            );
            const cutUrl = await api.removeBackground(url);
            const blob = await api.fetchImageBlob(cutUrl);
            return { index, ok: blob.size > 0, ms: Date.now() - started, detail: `${blob.size}B` };
          } catch (error) {
            return { index, ok: false, ms: Date.now() - started, detail: messageOf(error) };
          }
        }),
      );

      const wall = Date.now() - startedAll;
      const succeeded = results.filter((row) => row.ok).length;
      for (const row of results) {
        console.log(`  #${row.index + 1} ${row.ok ? 'OK  ' : 'FAIL'} ${String(row.ms).padStart(6)}ms  ${row.detail}`);
      }
      console.log(`  并发 ${count}：总耗时 ${wall}ms，成功 ${succeeded}/${count}`);

      expect(succeeded).toBe(count);
    },
    240_000,
  );
});
