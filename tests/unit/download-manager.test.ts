import { describe, expect, it, vi } from 'vitest';
import { ErrorCode } from '../../src/shared/errors';
import { downloadImageBlob, runWithConcurrency } from '../../src/background/download-manager';

// The magic-number probe moved to `src/shared/image-mime.ts` (the editor needs
// it for local uploads too) and is covered by `image-mime.test.ts`.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

describe('runWithConcurrency', () => {
  it('never runs more than the limit and preserves input order', async () => {
    let active = 0;
    let maxActive = 0;
    const items = [10, 20, 30, 40, 50, 60];

    const results = await runWithConcurrency(items, 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return item * 2;
    });

    expect(maxActive).toBe(3);
    expect(results.map((result) => (result.ok ? result.value : null))).toEqual([20, 40, 60, 80, 100, 120]);
  });

  it('isolates failures so the rest of the batch still completes', async () => {
    const results = await runWithConcurrency([1, 2, 3, 4], 4, async (item) => {
      if (item % 2 === 0) throw new Error(`bad ${item}`);
      return item;
    });

    expect(results[0]).toEqual({ ok: true, value: 1 });
    expect(results[1]?.ok).toBe(false);
    expect(results[2]).toEqual({ ok: true, value: 3 });
    expect(results[3]?.ok).toBe(false);
  });
});

describe('downloadImageBlob', () => {
  it('downloads a PNG and reports the declared mime type', async () => {
    const fetchImpl = vi.fn(async () => new Response(PNG, { status: 200, headers: { 'Content-Type': 'image/png' } }));
    const result = await downloadImageBlob('https://ae01.alicdn.com/kf/A.jpg', { fetchImpl: fetchImpl as never });
    expect(result.mimeType).toBe('image/png');
    expect(result.blob.size).toBe(PNG.length);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('sniffs the magic number when the server says application/octet-stream', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JPEG, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
    );
    const result = await downloadImageBlob('https://ae01.alicdn.com/kf/A.jpg', { fetchImpl: fetchImpl as never });
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('fails on a non-image payload', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>nope</html>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    await expect(
      downloadImageBlob('https://ae01.alicdn.com/kf/A.jpg', { fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_MIME });
  });

  it('fails on an empty body', async () => {
    const fetchImpl = vi.fn(async () => new Response(new Uint8Array([]), { status: 200 }));
    await expect(
      downloadImageBlob('https://ae01.alicdn.com/kf/A.jpg', { fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ code: ErrorCode.DOWNLOAD_EMPTY });
  });

  it('fails on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 403 }));
    await expect(
      downloadImageBlob('https://ae01.alicdn.com/kf/A.jpg', { fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ code: ErrorCode.DOWNLOAD_FAILED });
  });

  it('rejects non-http urls before touching the network', async () => {
    const fetchImpl = vi.fn();
    await expect(
      downloadImageBlob('data:image/png;base64,AA', { fetchImpl: fetchImpl as never }),
    ).rejects.toMatchObject({ code: ErrorCode.DOWNLOAD_FAILED });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts with a timeout error when the request hangs', async () => {
    vi.useFakeTimers();
    const fetchImpl = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });

    const assertion = expect(
      downloadImageBlob('https://ae01.alicdn.com/kf/A.jpg', { fetchImpl: fetchImpl as never, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: ErrorCode.DOWNLOAD_FAILED });

    await vi.advanceTimersByTimeAsync(1_500);
    await assertion;
    vi.useRealTimers();
  });
});
