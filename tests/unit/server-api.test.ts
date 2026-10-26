/**
 * Response-shape tests for the background-removal endpoint.
 *
 * These exist because the live server is INCONSISTENT between endpoint families:
 *   - /api/auth/*, /api/admin/uploads/images  ->  {success, data:{...}}
 *   - /api/public/toy-image/v1/background/remove -> FLAT {job, asset}
 *
 * An earlier version only understood the enveloped form, so every cutout failed
 * with "抠图响应缺少结果图片地址" even though the server had answered correctly.
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/shared/errors';
import { ServerApi, readBodyText, readRemoveBackgroundPayload } from '../../src/services/server-api';
import type { FetchLike } from '../../src/services/server-api';

const BASE = 'https://cutout.test';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function apiReturning(response: Response): ServerApi {
  const fetchImpl: FetchLike = async () => response;
  return new ServerApi(BASE, fetchImpl);
}

/** The exact body the live service returns (captured from the real endpoint). */
const LIVE_SUCCESS_BODY = {
  job: {
    id: '7c883f54309e4db2989c9d1908ef333d',
    operation: 'background_remove',
    status: 'completed',
    asset_id: '7f289c329c424befa4384117f2127547',
    error: null,
    duration_ms: 1107.096,
  },
  asset: {
    id: '7f289c329c424befa4384117f2127547',
    kind: 'image',
    url: 'https://image-store-liu.oss-cn-beijing.aliyuncs.com/f76bcca6.png',
  },
};

/** The exact error body the live service returns (captured from the real endpoint). */
const LIVE_ERROR_BODY = { error: 'internal_error', message: 'HTTP Error 404: Not Found' };

describe('readRemoveBackgroundPayload', () => {  it('reads the flat {job, asset} body used by the live endpoint', () => {
    const payload = readRemoveBackgroundPayload(LIVE_SUCCESS_BODY);
    expect(payload.job?.status).toBe('completed');
    expect(payload.asset?.url).toBe(LIVE_SUCCESS_BODY.asset.url);
  });

  it('also reads the enveloped {success, data} form', () => {
    const payload = readRemoveBackgroundPayload({ success: true, data: LIVE_SUCCESS_BODY });
    expect(payload.job?.status).toBe('completed');
    expect(payload.asset?.url).toBe(LIVE_SUCCESS_BODY.asset.url);
  });

  it('returns an empty payload for absent or non-object bodies', () => {
    expect(readRemoveBackgroundPayload(null)).toEqual({});
    expect(readRemoveBackgroundPayload(undefined)).toEqual({});
    expect(readRemoveBackgroundPayload('nope')).toEqual({});
    expect(readRemoveBackgroundPayload({ success: true, data: null })).toEqual({});
  });

  it('does not fall back to `data` when the flat body already carries the payload', () => {
    const payload = readRemoveBackgroundPayload({ job: { status: 'completed' }, data: { asset: { url: 'nope' } } });
    expect(payload.asset).toBeUndefined();
    expect(payload.job?.status).toBe('completed');
  });
});

describe('ServerApi.removeBackground', () => {
  it('returns the asset url from the flat live body', async () => {
    const api = apiReturning(json(LIVE_SUCCESS_BODY));
    await expect(api.removeBackground('https://oss.test/in.png')).resolves.toBe(LIVE_SUCCESS_BODY.asset.url);
  });

  it('still returns the asset url from the enveloped body', async () => {
    const api = apiReturning(json({ success: true, data: LIVE_SUCCESS_BODY }));
    await expect(api.removeBackground('https://oss.test/in.png')).resolves.toBe(LIVE_SUCCESS_BODY.asset.url);
  });

  it('surfaces the server message when the live endpoint answers an internal error', async () => {
    const api = apiReturning(json(LIVE_ERROR_BODY, 500));
    await expect(api.removeBackground('https://oss.test/in.png')).rejects.toMatchObject({
      code: ErrorCode.CUTOUT_FAILED,
      message: 'HTTP Error 404: Not Found',
    });
  });

  it('reports a flat response without an asset url', async () => {
    const api = apiReturning(json({ job: { status: 'completed' }, asset: null }));
    await expect(api.removeBackground('https://oss.test/in.png')).rejects.toMatchObject({
      code: ErrorCode.CUTOUT_FAILED,
      message: '抠图响应缺少结果图片地址',
    });
  });

  it('rejects a completed job whose url is not http(s)', async () => {
    const api = apiReturning(json({ job: { status: 'completed' }, asset: { url: 'not-a-url' } }));
    await expect(api.removeBackground('https://oss.test/in.png')).rejects.toMatchObject({
      code: ErrorCode.CUTOUT_FAILED,
    });
  });

  it('rejects a failed job using the job error', async () => {
    const api = apiReturning(json({ job: { status: 'failed', error: 'model crashed' }, asset: null }));
    await expect(api.removeBackground('https://oss.test/in.png')).rejects.toMatchObject({
      code: ErrorCode.CUTOUT_FAILED,
      message: 'model crashed',
    });
  });

  it('rejects a non-completed job status', async () => {
    const api = apiReturning(json({ job: { status: 'processing' }, asset: null }));
    await expect(api.removeBackground('https://oss.test/in.png')).rejects.toMatchObject({
      code: ErrorCode.CUTOUT_FAILED,
      message: '抠图任务状态异常：processing',
    });
  });

  it('rejects on HTTP 401 with NOT_LOGGED_IN', async () => {
    const api = apiReturning(json({ success: false, message: 'Not logged in' }, 401));
    await expect(api.removeBackground('https://oss.test/in.png')).rejects.toMatchObject({
      code: ErrorCode.NOT_LOGGED_IN,
    });
  });

  it('posts input_url and max_size as JSON', async () => {
    let seen: { url: string; body: unknown; method?: string } | null = null;
    const fetchImpl: FetchLike = async (input, init) => {
      seen = { url: String(input), body: init?.body, method: init?.method };
      return json(LIVE_SUCCESS_BODY);
    };
    const api = new ServerApi(BASE, fetchImpl);
    await api.removeBackground('https://oss.test/in.png');

    expect(seen!.url).toBe(`${BASE}/api/public/toy-image/v1/background/remove`);
    expect(seen!.method).toBe('POST');
    expect(JSON.parse(String(seen!.body))).toEqual({ input_url: 'https://oss.test/in.png', max_size: 1600 });
  });
});

/**
 * Response bodies need their own deadline.
 *
 * `fetchWithTimeout` only covers the wait for headers, so a server that sends
 * headers and then stalls mid-body used to hang the cutout forever — reported
 * as "抠图一直处理中". These cases pin the deadline that turns it into a
 * retryable timeout instead.
 */
describe('readBodyText', () => {
  it('rejects with a timeout when the body never finishes', async () => {
    const stalled = new Response(
      new ReadableStream({
        start() {
          /* never enqueue, never close */
        },
      }),
    );
    await expect(readBodyText(stalled, 30)).rejects.toMatchObject({
      code: ErrorCode.CUTOUT_TIMEOUT,
    });
  });

  it('resolves normally when the body arrives in time', async () => {
    await expect(readBodyText(json({ ok: true }), 1000)).resolves.toBe('{"ok":true}');
  });
});
