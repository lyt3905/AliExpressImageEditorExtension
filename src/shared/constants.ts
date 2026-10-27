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
/**
 * Hard ceiling for ONE image's whole cutout (upload + process + download).
 *
 * The per-stage timeouts above should always fire first; this watchdog exists
 * because a hung promise anywhere in the chain used to leave the card saying
 * 「处理中」 forever with no way to retry. Sum of the stages plus a margin.
 */
export const CUTOUT_TOTAL_TIMEOUT_MS = 240_000;
export const LOGIN_TIMEOUT_MS = 15_000;

/**
 * Reject oversized local uploads (file picker / clipboard) before they reach
 * IndexedDB. The cutout endpoint downscales to `CUTOUT_MAX_SIZE` anyway, so
 * anything past this only costs a long, blocking write.
 */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const MAX_HISTORY = 50;

// ---------------------------------------------------------------- page fill

/**
 * Size ceiling for a PNG offered back to the product page.
 *
 * Deliberately NOT `MAX_UPLOAD_BYTES`: the vendor library that performs the
 * upload enforces its own 5 MB limit (`vendor/aeiir/shared/validation.js`,
 * `MAX_FILE_BYTES`), and exceeding it there fails halfway through the flow.
 * `page-filler.test.ts` asserts the two numbers match the vendored source.
 */
export const PAGE_FILL_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Earliest the editor tab may close itself after「回填到商品页」is clicked.
 *
 * Counted from the CLICK, because that is the wait the button promises — but it
 * is a floor, not a fixed delay. A fill takes 5–25 s on the real page and runs in
 * the service worker, so the close is held until the fill has reported back
 * (`auto-close.ts`); otherwise the tab disappeared mid-fill and the outcome was
 * only ever visible on the toolbar badge.
 *
 * Deliberately not persisted and not exposed in the Options page: it is a
 * convenience, and a stale stored value would be unexplainable later.
 */
export const FILL_AUTO_CLOSE_MS = 10_000;

/**
 * Grace period before the service worker is asked to close the editor tab.
 *
 * `window.close()` is the primary path — this page was opened with
 * `chrome.tabs.create`, so it is allowed to close itself. But a close that gets
 * silently ignored looks exactly like "the feature does not work", so the timer
 * that asks the background for help is armed *before* `window.close()` runs: if
 * the close works, the page is gone and the timer never fires.
 */
export const AUTO_CLOSE_FALLBACK_MS = 300;

/**
 * Grace period before the editor stops waiting for the cut-out queue to finish.
 *
 * Past this, the automatic compose runs with whatever material exists so a stuck
 * cut-out cannot mean "no 主图 today". It is **not** a give-up point: a product with
 * six photos legitimately takes longer than this to cut out.
 */
export const AUTO_COMPOSE_GRACE_MS = 30_000;

/**
 * When to stop waiting for the FIRST cut-out and report that there is nothing to do.
 *
 * Much longer than the grace period on purpose. The first version reused the grace
 * period for this, so a slow batch (six photos at 5–20 s each) hit the 30 s mark while
 * the cut-out count was still zero, latched the auto run as "already ran", and left
 * the panel showing 「素材就绪，准备排版…」 forever — the image only appeared after a
 * manual click.
 */
export const AUTO_COMPOSE_GIVE_UP_MS = 150_000;

/** Max side (logical px) a layer is scaled to when it first enters the canvas. */
export const INSERT_MAX_SIDE = 480;

/** Default server base URL (overridable from the Options page). */
export const DEFAULT_SERVER_URL = 'https://39.107.244.239';

// ---------------------------------------------------------------- vision

/**
 * Local OpenAI-compatible gateway used for material role binding.
 *
 * `127.0.0.1` on purpose: the gateway runs on the seller's own machine, so the
 * product photos never leave it. The URL stays configurable because a shared box
 * would need a different address, and hardcoding one would make that a code change.
 */
export const DEFAULT_VISION_BASE_URL = 'http://127.0.0.1:8788/v1';

/** Vision model used for role binding. Verified against the gateway: multimodal + JSON mode. */
export const DEFAULT_VISION_MODEL = 'glm-5.3';

/**
 * Pre-filled API key for the vision gateway, from `VITE_VISION_API_KEY`.
 *
 * Read at BUILD time, so the value lives in a gitignored `.env.local` instead of in
 * source: the repo (and any CI-built artifact) keeps shipping no secret, while a
 * developer's own `dist/` comes with the key already filled in. The Options page
 * still wins per browser — once anything is saved to `chrome.storage.local`, that
 * value is used instead of this default.
 *
 * Empty by default, and an empty key means "send no Authorization header": some
 * gateways do not check one, and a blank `Bearer ` would be worse than none.
 */
export const DEFAULT_VISION_API_KEY = (import.meta.env?.VITE_VISION_API_KEY ?? '').trim();

/**
 * How many candidate images one binding request may carry.
 *
 * Six is the number of image slots the AliExpress editor exposes, so a normal
 * product never exceeds it — this is a page-shaped limit, not a cost guess.
 *
 * Measured on the live gateway (synthetic fixtures, 512px, `glm-5.3`):
 *
 * | images | prompt tokens | latency |
 * | --- | --- | --- |
 * | 4 | 1663 | 3.8-5.8 s |
 * | 5 | 2029 | 3.8-3.9 s |
 * | 6 | 2395 | 4.7-9.2 s |
 *
 * ~366 tokens per extra image and no accuracy loss at six, so an earlier cap of 4
 * was costing coverage (the package photo is often the 5th or 6th slot) to save
 * nothing worth saving.
 */
export const VISION_MAX_CANDIDATES = 6;

/** Longest side of the thumbnail sent to the vision model. */
export const VISION_THUMBNAIL_SIZE = 512;

/** Vision round-trip budget. Generous: 4.5 s observed, cold model load can be slower. */
export const VISION_TIMEOUT_MS = 30_000;

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
  /** Last committed position/scale of the auto-added product-code text layer. */
  codePlacement: 'aiee:code-placement',
  /** Brand registry: [{ id, name, aliases, keywords, logoBlobId, ... }]. */
  brands: 'aiee:brands',
  /** Sync bookkeeping for the remote brand catalog (version / last sync / mirror). */
  brandCatalog: 'aiee:brand-catalog',
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

// ---------------------------------------------------------------- brand logo

/** Blob-id prefix for brand logo images inside the shared `blobs` store. */
export const BRAND_BLOB_PREFIX = 'brand-logo-';

/** Reject oversized logo uploads before they reach IndexedDB. */
export const MAX_BRAND_LOGO_BYTES = 4 * 1024 * 1024;

/** Accepted brand logo mime types. */
export const BRAND_LOGO_MIME_TYPES = WATERMARK_MIME_TYPES;

// ------------------------------------------------------------- brand catalog

/**
 * Which git ref the catalog is read from.
 *
 * Deliberately a branch, not a tag: a logo re-upload should be live after one
 * `git push`, not after a release. It points at the feature branch while brand
 * sync is still unreleased — **before merging, flip this back to `main`**,
 * otherwise deleting the branch silently breaks sync for every installed copy.
 */
const BRAND_CATALOG_REF = 'feat/ai-image-generation';

/**
 * Where `brands.json` + `logos/` live. Tried in order, first one that answers
 * wins, and the winner is remembered so the next sync starts there.
 *
 * Two URLs because `raw.githubusercontent.com` is unreliable from mainland
 * China: the jsDelivr mirror is fetched over a CDN instead. Both resolve to the
 * same ref, so a catalog edit is live after one commit — no release, no version
 * bump (that rule only covers `src/`).
 *
 * jsDelivr resolves refs containing `/` correctly (measured 2026-10-27 against
 * this very branch: it returned the then-current `version: 2`), so the mirror
 * stays usable with a slashed branch name. If it ever stops resolving, the
 * client just moves to the next mirror — no config change needed.
 */
export const BRAND_CATALOG_URLS = [
  `https://raw.githubusercontent.com/lyt3905/AliExpressImageEditorExtension/${BRAND_CATALOG_REF}/catalog/`,
  `https://cdn.jsdelivr.net/gh/lyt3905/AliExpressImageEditorExtension@${BRAND_CATALOG_REF}/catalog/`,
] as const;

/** File name of the catalog manifest inside a catalog directory. */
export const BRAND_CATALOG_FILE = 'brands.json';

/** A catalog is a small JSON manifest — anything bigger is a mistake or an attack. */
export const BRAND_CATALOG_MAX_BYTES = 512 * 1024;

/** Per-request budget for the manifest and for each logo. */
export const BRAND_CATALOG_TIMEOUT_MS = 15_000;

/** Skip the network entirely for this long after a successful sync. */
export const BRAND_CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

/** Upper bound on entries in one catalog; keeps a bad manifest from flooding storage. */
export const BRAND_CATALOG_MAX_BRANDS = 100;

/** Logo paths inside the catalog must look like `logos/<slug>.<ext>` and nothing else. */
export const BRAND_CATALOG_LOGO_PATTERN = /^logos\/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)$/;

/** Slug rules for `brands[].id` in the catalog. */
export const BRAND_CATALOG_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

// ---------------------------------------------------------------- transform

/** Degrees one press of「左转 / 右转」turns the selected layer. */
export const ROTATE_STEP_DEG = 90;

/**
 * The knob snaps to multiples of this while Shift is held.
 *
 * Free dragging stays free — snapping is opt-in, because it is the only way to
 * land on a round number with the mouse while still allowing a 3° correction.
 */
export const ROTATE_SNAP_DEG = 15;

/** Degrees one arrow-key press turns the knob. */
export const ROTATE_NUDGE_DEG = 1;
