import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../src/shared/errors';
import { HttpCutoutClient } from '../../src/services/cutout-client';
import type { FetchLike } from '../../src/services/server-api';

const BASE = 'https://cutout.test';

/** A minimal byte sequence that passes the PNG magic-number check. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function pngResponse(): Response {
  return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } });
}

/**
 * The real /background/remove response is a FLAT `{job, asset}` body — it is NOT
 * wrapped in `{success, data}` like the auth/upload endpoints. The mocks below
 * mirror the live service so this class of mismatch cannot regress unnoticed.
 */
function completedCutout(url = 'https://oss.test/cutout.png'): Response {
  return json({
    job: { id: 'job-1', operation: 'background_remove', status: 'completed', error: null, duration_ms: 42 },
    asset: { id: 'asset-1', kind: 'image', url },
  });
}

const SOURCE_BLOB = new Blob([PNG_BYTES], { type: 'image/png' });

interface Handlers {
  me?: () => Response | Promise<Response>;
  login?: () => Response | Promise<Response>;
  upload?: () => Response | Promise<Response>;
  remove?: () => Response | Promise<Response>;
  asset?: () => Response | Promise<Response>;
}

function makeFetch(handlers: Handlers, calls: string[] = []): FetchLike {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.replace(BASE, '')}`);
    if (url.endsWith('/api/auth/me')) return handlers.me ? handlers.me() : json({ success: true, data: { id: 1, username: 'admin' } });
    if (url.endsWith('/api/auth/login')) return handlers.login ? handlers.login() : json({ success: true, data: { id: 1, username: 'admin' } });
    if (url.endsWith('/api/admin/uploads/images')) {
      return handlers.upload ? handlers.upload() : json({ success: true, data: { url: 'https://oss.test/uploaded.png' } });
    }
    if (url.endsWith('/api/public/toy-image/v1/background/remove')) {
      return handlers.remove ? handlers.remove() : completedCutout();
    }
    if (url.startsWith('https://oss.test/')) return handlers.asset ? handlers.asset() : pngResponse();
    return json({ success: false, message: `unexpected ${method} ${url}` }, 404);
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('HttpCutoutClient.cutout', () => {
  it('uploads the Blob, triggers removal and returns the transparent PNG', async () => {
    const calls: string[] = [];
    const client = new HttpCutoutClient({ baseUrl: BASE, fetchImpl: makeFetch({}, calls) });

    const result = await client.cutout(SOURCE_BLOB);

    expect(result.mimeType).toBe('image/png');
    expect(result.blob.size).toBe(PNG_BYTES.length);
    expect(calls).toEqual([
      'GET /api/auth/me',
      'POST /api/admin/uploads/images',
      'POST /api/public/toy-image/v1/background/remove',
      'GET https://oss.test/cutout.png',
    ]);
  });

  it('accepts the enveloped {success,data} response shape as well', async () => {
    const client = new HttpCutoutClient({
      baseUrl: BASE,
      fetchImpl: makeFetch({ remove: () => json({ success: true, data: { job: { status: 'completed' }, asset: { url: 'https://oss.test/cutout.png' } } }) }),
    });
    await expect(client.cutout(SOURCE_BLOB)).resolves.toMatchObject({ mimeType: 'image/png' });
  });

  it('sends raw bytes rather than letting the server fetch an AliExpress URL', async () => {
    let uploadedBody: unknown = null;
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) return json({ success: true, data: { id: 1, username: 'admin' } });
      if (url.endsWith('/api/admin/uploads/images')) {
        uploadedBody = init?.body;
        expect(init?.body).toBeInstanceOf(FormData);
        expect((init?.body as FormData).get('file')).toBeInstanceOf(Blob);
        return json({ success: true, data: { url: 'https://oss.test/uploaded.png' } });
      }
      if (url.endsWith('/background/remove')) {
        const parsed = JSON.parse(String(init?.body)) as { input_url: string };
        expect(parsed.input_url).toBe('https://oss.test/uploaded.png');
        return completedCutout();
      }
      return pngResponse();
    };

    const client = new HttpCutoutClient({ baseUrl: BASE, fetchImpl });
    await client.cutout(SOURCE_BLOB);
    expect(uploadedBody).toBeInstanceOf(FormData);
  });

  it('logs in only once for consecutive images', async () => {
    const calls: string[] = [];
    const client = new HttpCutoutClient({ baseUrl: BASE, fetchImpl: makeFetch({}, calls) });
    await client.cutout(SOURCE_BLOB);
    await client.cutout(SOURCE_BLOB);
    expect(calls.filter((call) => call.includes('/api/auth/me'))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('background/remove'))).toHaveLength(2);
  });

  it('maps an upload HTTP error to UPLOAD_FAILED', async () => {
    const client = new HttpCutoutClient({
      baseUrl: BASE,
      fetchImpl: makeFetch({ upload: () => json({ success: false, message: 'disk full' }, 500) }),
    });
    await expect(client.cutout(SOURCE_BLOB)).rejects.toMatchObject({ code: ErrorCode.UPLOAD_FAILED });
  });

  it('maps 401 on upload to NOT_LOGGED_IN', async () => {
    const client = new HttpCutoutClient({
      baseUrl: BASE,
      fetchImpl: makeFetch({ upload: () => json({ success: false, message: 'Not logged in' }, 401) }),
    });
    await expect(client.cutout(SOURCE_BLOB)).rejects.toMatchObject({ code: ErrorCode.NOT_LOGGED_IN });
  });

  it('surfaces the flat internal_error body the live endpoint returns', async () => {
    const client = new HttpCutoutClient({
      baseUrl: BASE,
      fetchImpl: makeFetch({ remove: () => json({ error: 'internal_error', message: 'HTTP Error 404: Not Found' }, 500) }),
    });
    await expect(client.cutout(SOURCE_BLOB)).rejects.toMatchObject({
      code: ErrorCode.CUTOUT_FAILED,
      message: 'HTTP Error 404: Not Found',
    });
  });

  it('maps an enveloped business-level failure to CUTOUT_FAILED', async () => {
    const client = new HttpCutoutClient({
      baseUrl: BASE,
      fetchImpl: makeFetch({ remove: () => json({ success: false, message: 'no worker available' }) }),
    });
    await expect(client.cutout(SOURCE_BLOB)).rejects.toMatchObject({
      code: ErrorCode.CUTOUT_FAILED,
      message: 'no worker available',
    });
  });

  it('rejects a job that did not complete', async () => {
    const client = new HttpCutoutClient({
      baseUrl: BASE,
      fetchImpl: makeFetch({ remove: () => json({ job: { status: 'failed', error: 'model crashed' }, asset: null }) }),
    });
    await expect(client.cutout(SOURCE_BLOB)).rejects.toMatchObject({ code: ErrorCode.CUTOUT_FAILED });
  });

  it('rejects a missing asset url', async () => {
    const client = new HttpCutoutClient({
      baseUrl: BASE,
      fetchImpl: makeFetch({ remove: () => json({ job: { status: 'completed' }, asset: null }) }),
    });
    await expect(client.cutout(SOURCE_BLOB)).rejects.toMatchObject({
      code: ErrorCode.CUTOUT_FAILED,
      message: '抠图响应缺少结果图片地址',
    });
  });

  it('rejects a result that is not a PNG', async () => {
    const client = new HttpCutoutClient({
      baseUrl: BASE,
      fetchImpl: makeFetch({
        asset: () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'Content-Type': 'text/plain' } }),
      }),
    });
    await expect(client.cutout(SOURCE_BLOB)).rejects.toMatchObject({ code: ErrorCode.CUTOUT_FAILED });
  });

  it('rejects an empty result payload', async () => {
    const client = new HttpCutoutClient({
      baseUrl: BASE,
      fetchImpl: makeFetch({ asset: () => new Response(new Uint8Array([]), { status: 200 }) }),
    });
    await expect(client.cutout(SOURCE_BLOB)).rejects.toMatchObject({ code: ErrorCode.DOWNLOAD_EMPTY });
  });

  it('rejects an empty input without calling the network', async () => {
    const calls: string[] = [];
    const client = new HttpCutoutClient({ baseUrl: BASE, fetchImpl: makeFetch({}, calls) });
    await expect(client.cutout(new Blob([]))).rejects.toMatchObject({ code: ErrorCode.DOWNLOAD_EMPTY });
    expect(calls).toHaveLength(0);
  });

  it('aborts with CUTOUT_TIMEOUT when the server never answers', async () => {
    vi.useFakeTimers();
    const fetchImpl: FetchLike = async (input, init) => {
      const url = String(input);
      if (url.endsWith('/api/auth/me')) return json({ success: true, data: { id: 1, username: 'admin' } });
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    };

    const client = new HttpCutoutClient({ baseUrl: BASE, fetchImpl });
    const assertion = expect(client.cutout(SOURCE_BLOB)).rejects.toMatchObject({ code: ErrorCode.CUTOUT_TIMEOUT });
    await vi.advanceTimersByTimeAsync(61_000);
    await assertion;
  });
});
