/**
 * Cutout client.
 *
 * Implements the upload-then-process contract of the existing server:
 *   local Blob -> POST /api/admin/uploads/images -> server-side object URL
 *              -> POST /api/public/toy-image/v1/background/remove
 *              -> transparent PNG URL -> fetched back as a Blob
 *
 * The server never fetches an AliExpress URL: it only ever reads bytes the
 * plugin uploaded to it.
 */

import { AppError, ErrorCode, messageOf } from '../shared/errors';
import type { CutoutClient, CutoutResult } from '../shared/types';
import { ServerApi, type FetchLike } from './server-api';
import { clearCredentials, loadCredentials, loadSettings } from './settings';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function looksLikePng(blob: Blob): Promise<boolean> {
  if (blob.type && /^image\/png$/i.test(blob.type)) return true;
  try {
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (head.length < 8) return false;
    return PNG_MAGIC.every((byte, index) => head[index] === byte);
  } catch {
    return false;
  }
}

export interface HttpCutoutClientOptions {
  baseUrl?: string;
  fetchImpl?: FetchLike;
  api?: ServerApi;
}

export class HttpCutoutClient implements CutoutClient {
  private readonly api: ServerApi;

  /** Single-flight guard: concurrent cutouts must not trigger parallel logins. */
  private loginInFlight: Promise<void> | null = null;

  /** In-memory flag so we do not probe /api/auth/me on every single image. */
  private knownLoggedIn = false;

  constructor(options: HttpCutoutClientOptions = {}) {
    this.api = options.api ?? new ServerApi(options.baseUrl, options.fetchImpl);
  }

  get baseUrl(): string {
    return this.api.baseUrl;
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this.knownLoggedIn) return;
    if (this.loginInFlight) return this.loginInFlight;

    this.loginInFlight = (async () => {
      const existing = await this.api.currentUser().catch(() => null);
      if (existing) {
        this.knownLoggedIn = true;
        return;
      }
      const credentials = await loadCredentials();
      if (!credentials) {
        throw new AppError(ErrorCode.NOT_LOGGED_IN, '尚未登录抠图服务，请在扩展设置页登录后再试');
      }
      try {
        await this.api.login(credentials.username, credentials.password);
        this.knownLoggedIn = true;
      } catch (error) {
        throw new AppError(ErrorCode.NOT_LOGGED_IN, `登录已过期且自动登录失败：${messageOf(error)}`);
      }
    })();

    try {
      await this.loginInFlight;
    } finally {
      this.loginInFlight = null;
    }
  }

  private async cutoutOnce(input: Blob): Promise<CutoutResult> {
    await this.ensureLoggedIn();

    const filename = `aiee-source-${Date.now()}.png`;
    const uploadedUrl = await this.api.uploadImage(input, filename);
    const resultUrl = await this.api.removeBackground(uploadedUrl);
    const blob = await this.api.fetchImageBlob(resultUrl);

    if (!(await looksLikePng(blob))) {
      throw new AppError(ErrorCode.CUTOUT_FAILED, '抠图结果不是有效的 PNG');
    }
    return { blob, mimeType: 'image/png' };
  }

  async cutout(input: Blob): Promise<CutoutResult> {
    if (!input || input.size === 0) {
      throw new AppError(ErrorCode.DOWNLOAD_EMPTY, '抠图输入为空');
    }
    try {
      return await this.cutoutOnce(input);
    } catch (error) {
      // A stale SESSION cookie must not poison every later image.
      if (error instanceof AppError && error.code === ErrorCode.NOT_LOGGED_IN) {
        this.knownLoggedIn = false;
      }
      if (error instanceof AppError) throw error;
      throw new AppError(ErrorCode.CUTOUT_FAILED, messageOf(error));
    }
  }
}

/** Build a client from the stored settings. */
export async function createCutoutClient(fetchImpl?: FetchLike): Promise<HttpCutoutClient> {
  const settings = await loadSettings();
  return new HttpCutoutClient({ baseUrl: settings.serverUrl, ...(fetchImpl ? { fetchImpl } : {}) });
}

/** Forget the volatile credentials (used by the Options "logout" button). */
export async function forgetCredentials(): Promise<void> {
  await clearCredentials();
}
