/**
 * Downscaled copy of a picture, used as the *drawing* source of an image layer.
 *
 * ## Why
 *
 * Konva redraws the whole layer on every `_requestDraw()` — and a drag requests a
 * draw on every `mousemove` (`Node._setDragPosition`). Each image shape then runs
 * `drawImage(image, 0, 0, width, height)` (`konva/lib/shapes/Image.js`
 * `_sceneFunc`), so **the source resolution is paid again on every frame**.
 *
 * The canvas is 800×800 and the preview is ≤ 640 px, so a 1600×1600 cut-out
 * (`CUTOUT_MAX_SIZE`) is 2.56 MP of sampling for a shape that covers maybe
 * 400×400 on screen. Six of them in a composed canvas is ~15 MP of RGBA
 * resampling per frame — that is what made cut-out material crawl while an
 * ordinary photo (small, opaque) dragged smoothly.
 *
 * Keeping a downscaled copy next to the material makes the per-frame cost follow
 * what is *drawn* instead of what the file *contains*. Nothing is lost: the copy
 * is never smaller than the layer's drawn size at export, and never larger than
 * {@link PREVIEW_SOURCE_MAX_SIDE}.
 *
 * ## Why the scale is bucketed
 *
 * The useful resolution depends on the layer's scale, and the transformer changes
 * that scale continuously — keying the copy on the exact value would rebuild it on
 * every mouse move, which is the very cost we are removing. So the scale is
 * rounded **up** to the next {@link SCALE_BUCKET}: the copy is never smaller than
 * needed, and it is rebuilt only when the pointer crosses a bucket boundary.
 *
 * `width`/`height` in the result are always the layer's box, never the picture's
 * natural size: the node keeps the exact geometry it had before, only the pixels
 * Konva samples change.
 */

import { fitInside } from './fit-inside';

/**
 * Longest side of a copy, in pixels.
 *
 * Deliberately above the 800 px export canvas: a layer can be scaled to overflow
 * the canvas on purpose (the template's hero zoom does), and the export samples
 * the copy at the layer's drawn size.
 */
export const PREVIEW_SOURCE_MAX_SIDE = 1024;

/** Scale quantisation step for the copy size; see the module comment. */
export const SCALE_BUCKET = 0.25;

/** Enough of a picture for the natural size, without depending on the DOM type. */
export interface PreviewImage {
  naturalWidth?: number;
  naturalHeight?: number;
  width?: number;
  height?: number;
}

export interface PreviewSource {
  /** What Konva should draw — the original picture, or a downscaled canvas. */
  image: CanvasImageSource;
  /** Size to draw into: the layer's box, not the picture's natural size. */
  width: number;
  height: number;
  /** `true` when the original picture is used as-is (already small enough). */
  original: boolean;
}

export interface PreviewSourceCanvas {
  canvas: CanvasImageSource;
  context: Pick<
    CanvasRenderingContext2D,
    'drawImage' | 'imageSmoothingEnabled' | 'imageSmoothingQuality'
  >;
}

export type PreviewSourceCanvasFactory = (
  width: number,
  height: number,
) => PreviewSourceCanvas | null;

export interface PreviewSources {
  /**
   * Drawing source for `image` when it fills a `boxWidth × boxHeight` layer box at
   * `scale`, or `null` when the picture has no usable size yet (still decoding).
   */
  for(
    image: PreviewImage,
    boxWidth: number,
    boxHeight: number,
    scale?: number,
  ): PreviewSource | null;
  /** How many copies have been rasterised. `?debug=drag` reports it. */
  readonly builds: number;
  /** Cumulative rasterisation time in milliseconds. `?debug=drag` reports it. */
  readonly buildMs: number;
  /** Forget every cached copy. */
  clear(): void;
}

export interface PreviewSourcesOptions {
  /** Replace the offscreen canvas (tests). */
  createCanvas?: PreviewSourceCanvasFactory;
  /** Longest side of the copy; defaults to {@link PREVIEW_SOURCE_MAX_SIDE}. */
  maxSide?: number;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function naturalSize(image: PreviewImage): { width: number; height: number } | null {
  const width = Number(image.naturalWidth ?? image.width) || 0;
  const height = Number(image.naturalHeight ?? image.height) || 0;
  if (width > 0 && height > 0) return { width, height };
  return null;
}

/** Round a scale up to the next bucket so a copy is never too small. */
export function quantiseScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(SCALE_BUCKET, Math.ceil(scale / SCALE_BUCKET) * SCALE_BUCKET);
}

function domCanvas(width: number, height: number): PreviewSourceCanvas | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  return { canvas, context };
}

interface CachedCopy {
  key: string;
  source: PreviewSource;
}

/**
 * One copy per picture, keyed by the copy's size.
 *
 * Only the newest size is kept: a picture is drawn at one size at a time, and
 * holding every bucket a transformer drag passed through would pile up canvases
 * (each up to 4 MB). Dropping the previous copy is safe — it is regenerated from
 * the material the moment it is needed again.
 */
export function createPreviewSources(options: PreviewSourcesOptions = {}): PreviewSources {
  let cache = new WeakMap<object, CachedCopy>();
  const createCanvas = options.createCanvas ?? domCanvas;
  const maxSide = options.maxSide ?? PREVIEW_SOURCE_MAX_SIDE;
  let builds = 0;
  let buildMs = 0;

  return {
    for(image, boxWidth, boxHeight, scale = 1) {
      if (!(boxWidth > 0) || !(boxHeight > 0)) return null;
      const natural = naturalSize(image);
      if (!natural) return null;

      const originalSource = (): PreviewSource => ({
        image: image as unknown as CanvasImageSource,
        width: boxWidth,
        height: boxHeight,
        original: true,
      });

      // Small enough already: drawing it costs nothing, and a copy would only add
      // a canvas to keep alive.
      if (Math.max(natural.width, natural.height) <= maxSide) return originalSource();

      const drawn = quantiseScale(scale);
      const size = fitInside(boxWidth * drawn, boxHeight * drawn, maxSide);
      if (size.width <= 0 || size.height <= 0) return originalSource();

      const key = `${size.width}x${size.height}`;
      const cached = cache.get(image);
      if (cached && cached.key === key) return cached.source;

      const started = now();
      const surface = createCanvas(size.width, size.height);

      let source: PreviewSource;
      if (surface) {
        const { context } = surface;
        // One-off cost, so ask for the best downscale the browser offers.
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image as unknown as CanvasImageSource, 0, 0, size.width, size.height);
        source = { image: surface.canvas, width: boxWidth, height: boxHeight, original: false };
        builds += 1;
        buildMs += now() - started;
      } else {
        // No canvas: better to pay the per-frame cost than to draw nothing.
        source = originalSource();
      }

      cache.set(image, { key, source });
      return source;
    },
    get builds() {
      return builds;
    },
    get buildMs() {
      return buildMs;
    },
    clear() {
      cache = new WeakMap<object, CachedCopy>();
      builds = 0;
      buildMs = 0;
    },
  };
}
