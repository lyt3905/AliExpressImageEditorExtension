/**
 * Thin client for the EXISTING Toy Item Prod server (https://39.107.244.239).
 *
 * Only pre-existing endpoints are used — the server is never modified:
 *
 *   POST /api/auth/login                                  JSON {username,password} -> Set-Cookie: SESSION
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *   POST /api/admin/uploads/images                        multipart "file" -> {success,data:{url}}
 *   POST /api/public/toy-image/v1/background/remove       JSON {input_url,max_size} -> {job,asset}
 *
 * NOTE: the two families of responses are shaped differently on this server —
 * `/api/auth/*` and the upload endpoint wrap their payload in `{success,data}`,
 * while the background-removal endpoint answers with a FLAT `{job,asset}` body
 * (verified against the live service). Both are handled explicitly below.
 *
 * Auth is cookie-only (there is no header/token scheme on this server), and the
 * SESSION cookie is `SameSite=Lax`. Chromium treats an extension request as
 * same-site when the extension holds host permission for the target, so
 * `credentials: 'include'` is enough for the cookie to ride along.
 */

import {
  CUTOUT_MAX_SIZE,
  CUTOUT_PROCESS_TIMEOUT_MS,
  CUTOUT_RESULT_TIMEOUT_MS,
  CUTOUT_UPLOAD_TIMEOUT_MS,
  DEFAULT_SERVER_URL,
  LOGIN_TIMEOUT_MS,
} from '../shared/constants';
import { AppError, ErrorCode, messageOf } from '../shared/errors';

export const SERVER_ROUTES = {
  login: '/api/auth/login',
  logout: '/api/auth/logout',
  me: '/api/auth/me',
  uploadImage: '/api/admin/uploads/images',
  removeBackground: '/api/public/toy-image/v1/background/remove',
} as const;

export interface AuthUser {
  id: number | string;
  username: string;
  role?: string;
}

export interface ServerEnvelope<T> {
  success?: boolean;
  data?: T;
  message?: string | null;
  error?: string;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function normalizeBaseUrl(baseUrl: string | undefined | null): string {
  const value = String(baseUrl ?? '').trim() || DEFAULT_SERVER_URL;
  return value.replace(/\/+$/, '');
}

/** Run `fetch` with an AbortController-based timeout. */
export async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted = controller.signal.aborted;
    const name = (error as { name?: string } | null)?.name;
    if (aborted || name === 'AbortError') {
      throw new AppError(ErrorCode.CUTOUT_TIMEOUT, `请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw new AppError(ErrorCode.UNKNOWN, `网络请求失败：${messageOf(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function readEnvelope(response: Response, timeoutMs: number): Promise<ServerEnvelope<unknown> | null> {
  try {
    const text = await readBodyText(response, timeoutMs);
    if (!text) return null;
    return JSON.parse(text) as ServerEnvelope<unknown>;
  } catch (error) {
    if (error instanceof AppError) throw error;
    return null;
  }
}

/**
 * Read a response body with a deadline.
 *
 * `fetchWithTimeout` only covers the wait for RESPONSE HEADERS. A server that
 * sends headers and then stalls mid-body would leave the awaiting code hanging
 * forever — which surfaced as "抠图一直处理中" when the background-removal
 * endpoint stopped answering. Racing the body read against a timer turns that
 * into a timeout error the UI can show and retry.
 */
export async function readBodyText(response: Response, timeoutMs: number): Promise<string> {
  return raceWithDeadline(() => response.text(), timeoutMs, '读取响应内容');
}

export async function readBodyBlob(response: Response, timeoutMs: number): Promise<Blob> {
  return raceWithDeadline(() => response.blob(), timeoutMs, '下载响应内容');
}

async function raceWithDeadline<T>(
  run: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AppError(
                ErrorCode.CUTOUT_TIMEOUT,
                `${label}超时（${Math.round(timeoutMs / 1000)} 秒），服务端可能无响应`,
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

function envelopeMessage(envelope: ServerEnvelope<unknown> | null): string {
  if (!envelope) return '';
  const message = envelope.message ?? envelope.error;
  return typeof message === 'string' && message ? message : '';
}

export interface RemoveBackgroundPayload {
  job?: { status?: string; error?: string | null };
  asset?: { url?: string };
}

/**
 * Extract `{job, asset}` from a background-removal response.
 *
 * The live endpoint answers with a FLAT body:
 *     {"job":{"status":"completed",...},"asset":{"id":"...","url":"https://...png"}}
 *
 * while `/api/auth/*` and `/api/admin/uploads/images` wrap theirs in
 * `{"success":true,"data":{...}}`. Both are accepted here so that this
 * server-side inconsistency can never silently drop the result URL.
 */
export function readRemoveBackgroundPayload(raw: unknown): RemoveBackgroundPayload {
  if (!raw || typeof raw !== 'object') return {};
  const root = raw as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [root];
  if (root.data && typeof root.data === 'object') {
    candidates.push(root.data as Record<string, unknown>);
  }
  for (const candidate of candidates) {
    if (candidate.job || candidate.asset) {
      return {
        job: (candidate.job as RemoveBackgroundPayload['job']) ?? undefined,
        asset: (candidate.asset as RemoveBackgroundPayload['asset']) ?? undefined,
      };
    }
  }
  return {};
}

export class ServerApi {
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(baseUrl: string | undefined | null, fetchImpl?: FetchLike) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    const impl = fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!impl) throw new AppError(ErrorCode.UNKNOWN, '当前环境不支持 fetch');
    this.fetchImpl = impl;
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  /** `credentials: 'include'` on every call: the server only understands the SESSION cookie. */
  private json(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    return fetchWithTimeout(
      this.fetchImpl,
      this.url(path),
      {
        ...init,
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json', ...(init.headers ?? {}) },
      },
      timeoutMs,
    );
  }

  async login(username: string, password: string): Promise<AuthUser> {
    const response = await this.json(
      SERVER_ROUTES.login,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      },
      LOGIN_TIMEOUT_MS,
    );
    const envelope = await readEnvelope(response, LOGIN_TIMEOUT_MS);
    if (response.status === 401) {
      throw new AppError(ErrorCode.NOT_LOGGED_IN, envelopeMessage(envelope) || '用户名或密码不正确');
    }
    if (!response.ok || envelope?.success === false) {
      throw new AppError(ErrorCode.NOT_LOGGED_IN, envelopeMessage(envelope) || `登录失败（HTTP ${response.status}）`);
    }
    const user = envelope?.data as AuthUser | undefined;
    if (!user || !user.username) throw new AppError(ErrorCode.NOT_LOGGED_IN, '登录响应缺少用户信息');
    return user;
  }

  async logout(): Promise<void> {
    try {
      await this.json(SERVER_ROUTES.logout, { method: 'POST' }, LOGIN_TIMEOUT_MS);
    } catch {
      // Logging out is best-effort; local credentials are cleared regardless.
    }
  }

  /** Returns the current user, or null when the SESSION cookie is missing/expired. */
  async currentUser(): Promise<AuthUser | null> {
    const response = await this.json(SERVER_ROUTES.me, { method: 'GET' }, LOGIN_TIMEOUT_MS);
    if (response.status === 401) return null;
    const envelope = await readEnvelope(response, LOGIN_TIMEOUT_MS);
    if (!response.ok || envelope?.success === false) return null;
    return (envelope?.data as AuthUser | undefined) ?? null;
  }

  /**
   * Upload raw bytes. The server answers with a URL on its own object storage,
   * which is what the background-removal endpoint expects as `input_url`.
   */
  async uploadImage(blob: Blob, filename = 'source.png'): Promise<string> {
    const form = new FormData();
    form.append('file', blob, filename);

    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(SERVER_ROUTES.uploadImage),
      { method: 'POST', body: form, credentials: 'include', cache: 'no-store' },
      CUTOUT_UPLOAD_TIMEOUT_MS,
    );

    const envelope = await readEnvelope(response, CUTOUT_UPLOAD_TIMEOUT_MS);
    if (response.status === 401) {
      throw new AppError(ErrorCode.NOT_LOGGED_IN, '未登录或登录已过期');
    }
    if (!response.ok || envelope?.success === false) {
      throw new AppError(ErrorCode.UPLOAD_FAILED, envelopeMessage(envelope) || `上传失败（HTTP ${response.status}）`);
    }
    const url = (envelope?.data as { url?: string } | undefined)?.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      throw new AppError(ErrorCode.UPLOAD_FAILED, '上传响应缺少图片地址');
    }
    return url;
  }

  /** Run background removal on a URL that this server itself produced. */
  async removeBackground(inputUrl: string, maxSize = CUTOUT_MAX_SIZE): Promise<string> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      this.url(SERVER_ROUTES.removeBackground),
      {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ input_url: inputUrl, max_size: maxSize }),
      },
      CUTOUT_PROCESS_TIMEOUT_MS,
    );

    const envelope = await readEnvelope(response, CUTOUT_PROCESS_TIMEOUT_MS);
    if (response.status === 401) {
      throw new AppError(ErrorCode.NOT_LOGGED_IN, '未登录或登录已过期');
    }
    if (!response.ok || envelope?.success === false) {
      throw new AppError(ErrorCode.CUTOUT_FAILED, envelopeMessage(envelope) || `抠图失败（HTTP ${response.status}）`);
    }

    const payload = readRemoveBackgroundPayload(envelope);
    if (payload.job?.status && payload.job.status !== 'completed') {
      throw new AppError(ErrorCode.CUTOUT_FAILED, payload.job.error || `抠图任务状态异常：${payload.job.status}`);
    }
    const assetUrl = payload.asset?.url;
    if (!assetUrl || !/^https?:\/\//i.test(assetUrl)) {
      const detail = envelopeMessage(envelope);
      throw new AppError(ErrorCode.CUTOUT_FAILED, detail ? `抠图失败：${detail}` : '抠图响应缺少结果图片地址');
    }
    return assetUrl;
  }

  /** Fetch the transparent PNG produced by the server. */
  async fetchImageBlob(url: string): Promise<Blob> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      url,
      { method: 'GET', credentials: 'include', cache: 'no-store' },
      CUTOUT_RESULT_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new AppError(ErrorCode.CUTOUT_FAILED, `下载抠图结果失败（HTTP ${response.status}）`);
    }
    // Body reads carry their own deadline: a server that stalls mid-body would
    // otherwise hang this forever (see `readBodyText`).
    const blob = await readBodyBlob(response, CUTOUT_RESULT_TIMEOUT_MS);
    if (!blob || blob.size === 0) {
      throw new AppError(ErrorCode.DOWNLOAD_EMPTY, '抠图结果为空文件');
    }
    return blob;
  }
}
