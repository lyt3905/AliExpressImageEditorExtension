/** Shared constants. Keep every magic number in one place. */

/** Logical canvas size. All business coordinates use this space. */
export const CANVAS_SIZE = 800;

/** Final export is ALWAYS white background PNG. */
export const EXPORT_BACKGROUND = '#ffffff';
export const EXPORT_MIME = 'image/png';

/**
 * Cutout queue concurrency: how many images are uploading / being removed at once.
 * Raised from 2 to 6 on request — see README for the observed server behaviour.
 */
export const CUTOUT_CONCURRENCY = 6;

/** Remote AliExpress image download concurrency. */
export const IMAGE_DOWNLOAD_CONCURRENCY = 4;

export const IMAGE_DOWNLOAD_TIMEOUT_MS = 20_000;
export const CUTOUT_UPLOAD_TIMEOUT_MS = 60_000;
export const CUTOUT_PROCESS_TIMEOUT_MS = 180_000;
export const CUTOUT_RESULT_TIMEOUT_MS = 60_000;
export const LOGIN_TIMEOUT_MS = 15_000;

export const MAX_HISTORY = 50;

/** Max side (logical px) a layer is scaled to when it first enters the canvas. */
export const INSERT_MAX_SIDE = 480;

/** Default server base URL (overridable from the Options page). */
export const DEFAULT_SERVER_URL = 'https://39.107.244.239';

/** `max_size` parameter forwarded to the background-removal endpoint. */
export const CUTOUT_MAX_SIZE = 1600;

export const EXTENSION_TITLE = 'AliExpress 图片编辑器';

export const STORAGE_KEYS = {
  settings: 'aiee:settings',
  sessionPrefix: 'aiee:session:',
  credentials: 'aiee:credentials',
  watermarks: 'aiee:watermarks',
} as const;

export const DB_NAME = 'aliexpress-image-editor';
export const DB_VERSION = 1;
export const STORE_BLOBS = 'blobs';
export const STORE_IMAGES = 'images';

// ---------------------------------------------------------------- watermark

/** Blob-id prefix for watermark images inside the shared `blobs` store. */
export const WATERMARK_BLOB_PREFIX = 'watermark-';

/** Konva node name of the locked watermark frame (also used as its layer id). */
export const WATERMARK_LAYER_ID = 'watermark-frame';

/** Reject oversized uploads before they reach IndexedDB. */
export const MAX_WATERMARK_BYTES = 8 * 1024 * 1024;

/** Accepted watermark mime types. */
export const WATERMARK_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
