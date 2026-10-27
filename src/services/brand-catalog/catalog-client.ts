/**
 * Network side of the brand catalog: the manifest and the logo bytes.
 *
 * Two behaviours are deliberately baked in here rather than in the caller:
 *
 * 1. **Mirrors are tried in order.** `raw.githubusercontent.com` is unreliable
 *    from mainland China, so a failed host is not an error — it is the next
 *    entry in the list. Only "every mirror failed" is an error, and then the
 *    message lists what each one said, because the seller has to be able to tell
 *    "GitHub is blocked" from "your catalog JSON is broken".
 * 2. **Every response is size-checked before it is parsed.** A manifest is a few
 *    kilobytes; anything bigger is a mistake or an attack, and reading it into a
 *    string is the expensive part.
 *
 * The `fetchLike` port keeps this testable in plain node (see
 * `vision-client.ts` for the same pattern).
 */

import {
  BRAND_CATALOG_FILE,
  BRAND_CATALOG_MAX_BYTES,
  BRAND_CATALOG_TIMEOUT_MS,
  MAX_BRAND_LOGO_BYTES,
} from '../../shared/constants';
import { parseBrandCatalog, resolveCatalogUrl, type BrandCatalog } from './schema';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface CatalogAttempt {
  baseUrl: string;
  message: string;
}

export class CatalogFetchError extends Error {
  constructor(
    message: string,
    readonly attempts: CatalogAttempt[],
  ) {
    super(message);
    this.name = 'CatalogFetchError';
  }
}

export interface FetchedCatalog {
  catalog: BrandCatalog;
  /** Mirror that answered, normalised to end with a slash. */
  baseUrl: string;
  /** Failures that happened before that mirror, for the Options page log. */
  attempts: CatalogAttempt[];
}

export interface FetchCatalogOptions {
  baseUrls: readonly string[];
  fetchLike?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return run(controller.signal)
    .catch((error: unknown) => {
      if (controller.signal.aborted) throw onTimeout();
      throw error;
    })
    .finally(() => clearTimeout(timer));
}

/** Fetch and validate the manifest from the first mirror that answers. */
export async function fetchBrandCatalog(options: FetchCatalogOptions): Promise<FetchedCatalog> {
  const { baseUrls } = options;
  const fetchLike = options.fetchLike ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? BRAND_CATALOG_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? BRAND_CATALOG_MAX_BYTES;
  const attempts: CatalogAttempt[] = [];

  for (const baseUrl of baseUrls) {
    let url: string;
    try {
      url = resolveCatalogUrl(baseUrl);
    } catch (error) {
      attempts.push({ baseUrl, message: messageOf(error) });
      continue;
    }
    try {
      const text = await withTimeout(
        async (signal) => {
          const response = await fetchLike(url, {
            signal,
            cache: 'no-store',
            credentials: 'omit',
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const declared = Number(response.headers.get('content-length') ?? '');
          if (Number.isFinite(declared) && declared > maxBytes) {
            throw new Error(`目录过大（${Math.round(declared / 1024)}KB）`);
          }
          const body = await response.text();
          if (body.length > maxBytes) {
            throw new Error(`目录过大（${Math.round(body.length / 1024)}KB）`);
          }
          return body;
        },
        timeoutMs,
        () => new Error(`超时（>${Math.round(timeoutMs / 1000)}s）`),
      );
      const catalog = parseBrandCatalog(text);
      return { catalog, baseUrl: ensureTrailingSlash(baseUrl), attempts };
    } catch (error) {
      attempts.push({ baseUrl, message: messageOf(error) });
    }
  }

  const detail = attempts.map((entry) => `${hostOf(entry.baseUrl)}：${entry.message}`).join('；');
  throw new CatalogFetchError(`没拿到品牌目录${detail ? `（${detail}）` : ''}`, attempts);
}

export interface DownloadLogoOptions {
  fetchLike?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Download one logo as a `Blob`.
 *
 * The mime check is advisory (some static hosts send nothing at all) but a wrong
 * one is rejected: the registry feeds these blobs straight into the canvas.
 */
export async function downloadLogo(
  url: string,
  options: DownloadLogoOptions = {},
): Promise<Blob> {
  const fetchLike = options.fetchLike ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? BRAND_CATALOG_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BRAND_LOGO_BYTES;

  return withTimeout(
    async (signal) => {
      const response = await fetchLike(url, { signal, cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const declared = Number(response.headers.get('content-length') ?? '');
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw new Error(`图片过大（${Math.round(declared / 1024)}KB）`);
      }
      const blob = await response.blob();
      if (blob.size === 0) throw new Error('图片为空');
      if (blob.size > maxBytes) {
        throw new Error(`图片过大（${Math.round(blob.size / 1024)}KB）`);
      }
      const type = (blob.type || '').toLowerCase();
      if (type && !(BRAND_LOGO_MIME_TYPES_LOCAL as readonly string[]).includes(type)) {
        throw new Error(`不支持的图片格式：${type}`);
      }
      return blob;
    },
    timeoutMs,
    () => new Error(`超时（>${Math.round(timeoutMs / 1000)}s）`),
  );
}

// Kept local so this module's network layer does not import the storage layer.
const BRAND_LOGO_MIME_TYPES_LOCAL = ['image/png', 'image/jpeg', 'image/webp'] as const;

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export { BRAND_CATALOG_FILE };
