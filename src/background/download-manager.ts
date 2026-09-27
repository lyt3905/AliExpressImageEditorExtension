/**
 * Remote image download manager (service worker side).
 *
 * Requirement recap: bounded concurrency, per-image timeout, one failure must
 * not abort the batch, empty payloads and obviously wrong mime types fail.
 */

import { IMAGE_DOWNLOAD_CONCURRENCY, IMAGE_DOWNLOAD_TIMEOUT_MS } from '../shared/constants';
import { AppError, ErrorCode, messageOf } from '../shared/errors';
import { readBlobSize } from '../services/image-size';

export { readBlobSize };

const ACCEPT_HEADER = 'image/png,image/jpeg,image/webp,*/*;q=0.8';
const DECLARED_MIME = /^image\/(jpeg|jpg|png|webp)$/i;

export interface DownloadedImage {
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
}

export type SettledResult<T> = { ok: true; value: T } | { ok: false; error: AppError };

/** Probe the first bytes so `application/octet-stream` responses can still be accepted. */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
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
  const blob = await response.blob();
  if (!blob || blob.size === 0) {
    throw new AppError(ErrorCode.DOWNLOAD_EMPTY, '图片内容为空');
  }

  let mimeType = declared;
  if (!DECLARED_MIME.test(mimeType)) {
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
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
