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

/**
 * Reject oversized local uploads (file picker / clipboard) before they reach
 * IndexedDB. The cutout endpoint downscales to `CUTOUT_MAX_SIZE` anyway, so
 * anything past this only costs a long, blocking write.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

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
  /** Last used text style, so a new text layer starts where the last one ended. */
  textDefaults: 'aiee:text-defaults',
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

// ---------------------------------------------------------------- text layers

/** Fonts the text panel offers. Local system fonts only — never a web font. */
export const TEXT_FONT_FAMILIES = [
  'Microsoft YaHei',
  'Arial',
  'SimHei',
  'SimSun',
  'sans-serif',
  'serif',
] as const;

export const MIN_FONT_SIZE = 12;
export const MAX_FONT_SIZE = 200;

/** Defaults for a freshly created text layer (see `createTextLayer`). */
export const TEXT_LAYER_DEFAULTS = {
  text: '请输入文字',
  width: 400,
  fontSize: 48,
  fontFamily: 'Microsoft YaHei',
  fill: '#000000',
  fontStyle: 'normal',
  align: 'center',
  scale: 1,
  rotation: 0,
  // Outline and shadow are OFF by default, so a new text layer still looks
  // exactly like it did before these options existed.
  stroke: '#ffffff',
  strokeWidth: 0,
  shadowColor: '#000000',
  shadowBlur: 0,
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  shadowOpacity: 0.5,
} as const;

/**
 * Outline width in logical px. 0 = no outline.
 *
 * Konva draws it in the node's own coordinates, so it scales with the layer
 * exactly like the glyphs do.
 */
export const MIN_STROKE_WIDTH = 0;
export const MAX_STROKE_WIDTH = 40;

/**
 * The text fields that count as "style" — the ones a new text layer inherits
 * from the last edit.
 *
 * Deliberately excludes `text` (a new layer must never inherit the previous
 * wording), `x` / `y` (otherwise layers stack on top of each other) and
 * `width` / `scale` / `rotation` (both should restart at their neutral value).
 *
 * SINGLE SOURCE OF TRUTH: `pickTextStyle` reads it and `TextStyleDefaults` is
 * derived from it, so the two can never drift apart.
 */
export const TEXT_STYLE_KEYS = [
  'fontSize',
  'fontFamily',
  'fill',
  'fontStyle',
  'align',
  'stroke',
  'strokeWidth',
  'shadowColor',
  'shadowBlur',
  'shadowOffsetX',
  'shadowOffsetY',
  'shadowOpacity',
] as const;

/**
 * Shadow limits, logical px. Same units as the outline, same scaling rule.
 * The shadow is only drawn while `blur` or one of the offsets is non-zero.
 */
export const MIN_SHADOW_BLUR = 0;
export const MAX_SHADOW_BLUR = 80;
export const MIN_SHADOW_OFFSET = -100;
export const MAX_SHADOW_OFFSET = 100;

/** Longest label shown for a text layer in the layer list before truncation. */
export const TEXT_LAYER_LABEL_MAX = 24;
