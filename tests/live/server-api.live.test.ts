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
import { describe, expect, it } from 'vitest';
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
});
