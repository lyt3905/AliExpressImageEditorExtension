/** Error codes + a small error helper. No stack traces are sent across contexts. */

export const ErrorCode = {
  /** No usable active tab. */
  NO_ACTIVE_TAB: 'E_NO_ACTIVE_TAB',
  /** Active tab is not a supported AliExpress seller page. */
  UNSUPPORTED_PAGE: 'E_UNSUPPORTED_PAGE',
  /** Page scan returned zero usable images. */
  NO_IMAGES: 'E_NO_IMAGES',
  /** Content script is not reachable / not injected. */
  CONTENT_SCRIPT_UNAVAILABLE: 'E_CONTENT_SCRIPT_UNAVAILABLE',
  /** Remote image download failed. */
  DOWNLOAD_FAILED: 'E_DOWNLOAD_FAILED',
  /** Downloaded payload is empty. */
  DOWNLOAD_EMPTY: 'E_DOWNLOAD_EMPTY',
  /** Downloaded payload has an unexpected mime type. */
  BAD_MIME: 'E_BAD_MIME',
  /** IndexedDB write/read failed. */
  STORE_FAILED: 'E_STORE_FAILED',
  /** Editor session is missing or expired. */
  SESSION_NOT_FOUND: 'E_SESSION_NOT_FOUND',
  /** Not logged in to the cutout server. */
  NOT_LOGGED_IN: 'E_NOT_LOGGED_IN',
  /** Cutout upload rejected. */
  UPLOAD_FAILED: 'E_UPLOAD_FAILED',
  /** Cutout request failed on the server. */
  CUTOUT_FAILED: 'E_CUTOUT_FAILED',
  /** Cutout request timed out client-side. */
  CUTOUT_TIMEOUT: 'E_CUTOUT_TIMEOUT',
  /** Requested feature is intentionally not implemented in v1. */
  NOT_IMPLEMENTED: 'E_NOT_IMPLEMENTED',
  /** Unknown/unexpected failure. */
  UNKNOWN: 'E_UNKNOWN',
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  readonly code: ErrorCodeValue;

  constructor(code: ErrorCodeValue, message: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export function toAppError(error: unknown, fallbackMessage = '发生未知错误'): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new AppError(ErrorCode.UNKNOWN, error.message || fallbackMessage);
  if (typeof error === 'string' && error) return new AppError(ErrorCode.UNKNOWN, error);
  return new AppError(ErrorCode.UNKNOWN, fallbackMessage);
}

export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return String(error);
}
