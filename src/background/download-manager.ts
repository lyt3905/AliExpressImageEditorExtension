/**
 * Remote image download manager (service worker side).
 *
 * Requirement recap: bounded concurrency, per-image timeout, one failure must
 * not abort the batch, empty payloads and obviously wrong mime types fail.
 */

import { IMAGE_DOWNLOAD_CONCURRENCY, IMAGE_DOWNLOAD_TIMEOUT_MS } from '../shared/constants';
import { AppError, ErrorCode, messageOf } from '../shared/errors';
import { DECLARED_IMAGE_MIME, MIME_SNIFF_BYTES, sniffImageMime } from '../shared/image-mime';
import { readBlobSize } from '../services/image-size';

export { readBlobSize };

const ACCEPT_HEADER = 'image/png,image/jpeg,image/webp,*/*;q=0.8';

export interface DownloadedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

export type SettledResult<T> = { ok: true; value: T } | { ok: false; error: AppError };

/**
 * Read a response body with a deadline.
 *
 * `AbortController` covers the request only until the response HEADERS arrive;
 * a body that stalls afterwards would hang here forever. Racing the read
 * against a timer turns that into an ordinary download failure.
 */
async function readBodyWithDeadline(response: Response, timeoutMs: number): Promise<Blob> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      response.blob(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(
                ErrorCode.DOWNLOAD_FAILED,
                `图片下载超时（读取内容超过 ${Math.round(timeoutMs / 1000)} 秒）`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface DownloadOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export async function downloadImageBlob(url: string, options: DownloadOptions = {}): Promise<DownloadedImage> {
  const timeoutMs = options.timeoutMs ?? IMAGE_DOWNLOAD_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  if (!/^https?:\/\//i.test(url)) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, '图片地址不是 http(s) URL');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: ACCEPT_HEADER },
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = controller.signal.aborted;
    throw new AppError(
      ErrorCode.DOWNLOAD_FAILED,
      aborted ? `图片下载超时（${Math.round(timeoutMs / 1000)} 秒）` : `图片下载失败：${messageOf(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new AppError(ErrorCode.DOWNLOAD_FAILED, `图片下载失败（HTTP ${response.status}）`);
  }

  const declared = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  /*
    The body read carries its own deadline: the AbortController above only
    covered the wait for headers, so a stalled body would hang the whole scan
    flow with no error to report.
  */
  const blob = await readBodyWithDeadline(response, timeoutMs);
  if (!blob || blob.size === 0) {
    throw new AppError(ErrorCode.DOWNLOAD_EMPTY, '图片内容为空');
  }

  let mimeType = declared;
  if (!DECLARED_IMAGE_MIME.test(mimeType)) {
    const head = new Uint8Array(await blob.slice(0, MIME_SNIFF_BYTES).arrayBuffer());
    const sniffed = sniffImageMime(head);
    if (!sniffed) {
      throw new AppError(ErrorCode.BAD_MIME, `不支持的图片格式：${declared || '未知'}`);
    }
    mimeType = sniffed;
  }

  const { width, height } = await readBlobSize(blob);
  return { blob, mimeType, width, height };
}

/** Run `worker` over `items` with a hard cap on parallelism. Order is preserved. */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<Array<SettledResult<R>>> {
  const size = Math.max(1, Math.min(Math.floor(limit) || 1, items.length || 1));
  const results = new Array<SettledResult<R>>(items.length);
  let cursor = 0;

  async function runner(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index] as T, index) };
      } catch (error) {
        results[index] = {
          ok: false,
          error: error instanceof AppError ? error : new AppError(ErrorCode.UNKNOWN, messageOf(error)),
        };
      }
    }
  }

  await Promise.all(Array.from({ length: size }, runner));
  return results;
}

export const DOWNLOAD_CONCURRENCY = IMAGE_DOWNLOAD_CONCURRENCY;
