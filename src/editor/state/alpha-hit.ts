/**
 * Alpha-accurate hit area for picture layers.
 *
 * ## Why not composite straight into the hit canvas
 *
 * Konva's default hit for an image is its whole rectangle, so a cut-out's
 * transparent background swallows every click meant for the picture underneath.
 * The obvious fix — draw the image into the hit canvas, then composite the hit
 * colour with `source-in` — is silently destructive, because **the hit canvas is
 * shared by every shape of the layer**:
 *
 * `source-in` is defined as "keep the source only where the destination already
 * has pixels". Inside the clip rectangle that means every destination pixel the
 * source does not cover ends up **transparent**. Shapes drawn earlier (the
 * pictures below, the plate) lose their hit pixels exactly under the upper
 * picture's bounding box — so the lower picture becomes unclickable precisely
 * where the upper one is transparent. Visible symptom: "上层的透明像素挡住了下层
 * 的图片，即使提前选中下层也点不中它".
 *
 * The fix is to build the mask **off to the side** and then paint it into the
 * shared hit canvas with plain `source-over`, which can only add pixels. Every
 * shape keeps whatever it registered before, and z-order decides the winner.
 *
 * The invariant this module guarantees: **painting a hit never removes a hit
 * pixel that is already there.**
 *
 * ## Why the mask is cached, and why it is smaller than the source
 *
 * Building that mask is the expensive half, and it used to happen on **every**
 * hit draw, at **source resolution**:
 *
 * - Konva repaints a layer's hit canvas on every `Layer.draw()` (`Layer.js`
 *   `drawHit` clears, then redraws every shape), and `Layer.draw()` runs on every
 *   `_requestDraw()`;
 * - react-konva re-applies **function props** on every render (`makeUpdates.js`
 *   compares `props[key] !== oldProps[key]`), so an inline `hitFunc` counts as
 *   changed and calls `setAttrs` → `updatePicture` → a full layer redraw;
 * - cut-outs are up to 1600x1600 (`CUTOUT_MAX_SIZE`), six of them in a composed
 *   canvas is ~15 MP of `drawImage` + `source-in` fill per redraw.
 *
 * That is a 60–150 ms freeze right where a drag starts (the press dispatches
 * `onSelect`, which re-renders the stage). The mask does not depend on the frame,
 * only on the picture and its hit colour, so it is rasterised **once** and reused
 * — and it only has to be accurate enough for the hit canvas, which is the
 * preview (≤ 640 px), so it is capped at {@link DEFAULT_MASK_MAX_SIDE} instead of
 * following the source. Painting then costs a single scaled `drawImage`.
 */

import { fitInside } from './fit-inside';

/** The slice of Konva's `Context` (HitContext) that hit painting needs. */
export interface HitPaintContext {
  save(): void;
  restore(): void;
  setAttr(attribute: string, value: unknown): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  /**
   * Konva forwards the 3- and 5-argument forms to the native `drawImage`
   * (`Context.js` `drawImage`), which is what lets a capped mask be scaled back
   * onto the layer's box in one call.
   */
  drawImage(
    image: CanvasImageSource,
    dx: number,
    dy: number,
    width?: number,
    height?: number,
  ): void;
}

/** The slice of a 2D context the offscreen mask needs. */
export type MaskPaintContext = Pick<
  CanvasRenderingContext2D,
  'globalCompositeOperation' | 'fillStyle' | 'drawImage' | 'fillRect'
>;

/** An offscreen canvas plus its 2D context, sized for one mask. */
export interface MaskSurface {
  canvas: CanvasImageSource;
  context: MaskPaintContext;
}

/** Creates the canvas a mask is rasterised into; `null` without a DOM. */
export type MaskSurfaceFactory = (width: number, height: number) => MaskSurface | null;

export interface AlphaHitTarget {
  /** Size of the layer's box in source pixels; the mask is scaled onto it. */
  sourceWidth: number;
  sourceHeight: number;
  /** Konva's unique hit colour for this shape; the hit canvas is read back by colour. */
  colorKey: string;
}

export interface AlphaHitMasks {
  /**
   * Paint `image`'s opaque pixels into the hit canvas as `target.colorKey`.
   *
   * Without a canvas factory (no DOM: SSR, unit tests) the whole rectangle is
   * registered instead — a picture that cannot be clicked at all is worse than
   * one whose transparent corners are clickable.
   */
  paint(hit: HitPaintContext, target: AlphaHitTarget, image: CanvasImageSource): void;
  /** How many masks have been rasterised. `?debug=drag` reports it. */
  readonly builds: number;
  /** Cumulative rasterisation time in milliseconds. `?debug=drag` reports it. */
  readonly buildMs: number;
  /** Forget every cached mask (tests, and after a template swap). */
  clear(): void;
}

/**
 * Longest side of a mask, in mask pixels.
 *
 * The hit canvas is never wider than the preview (`MAX_PREVIEW_SIZE = 640`) and
 * the exported canvas is 800×800, so a mask finer than this cannot resolve
 * anything the click or the export could tell apart — it only costs memory
 * (4 bytes/px) and rasterisation time.
 */
export const DEFAULT_MASK_MAX_SIDE = 1024;

interface CachedMask {
  canvas: CanvasImageSource;
  width: number;
  height: number;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Real offscreen canvas; `null` when there is no DOM. */
function domMaskSurface(width: number, height: number): MaskSurface | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  return { canvas, context };
}

export interface AlphaHitMasksOptions {
  /** Replace the offscreen canvas (tests). */
  createSurface?: MaskSurfaceFactory;
  /** Longest mask side; defaults to {@link DEFAULT_MASK_MAX_SIDE}. */
  maxSide?: number;
}

/**
 * Cache of hit masks, one per (picture, box size, hit colour).
 *
 * Keyed by the image object itself in a `WeakMap`, so dropping a material drops
 * its mask; the inner map covers the (rare) case of one picture used by two
 * layers with different boxes or hit colours.
 */
export function createAlphaHitMasks(options: AlphaHitMasksOptions = {}): AlphaHitMasks {
  const createSurface = options.createSurface ?? domMaskSurface;
  const maxSide = options.maxSide ?? DEFAULT_MASK_MAX_SIDE;

  let cache = new WeakMap<object, Map<string, CachedMask | null>>();
  let builds = 0;
  let buildMs = 0;

  const maskFor = (
    image: CanvasImageSource,
    sourceWidth: number,
    sourceHeight: number,
    colorKey: string,
  ): CachedMask | null => {
    if (typeof image !== 'object' || image === null) return null;

    let byKey = cache.get(image);
    if (!byKey) {
      byKey = new Map<string, CachedMask | null>();
      cache.set(image, byKey);
    }

    const key = `${sourceWidth}x${sourceHeight}@${colorKey}`;
    if (byKey.has(key)) return byKey.get(key) ?? null;

    const started = now();
    const size = fitInside(sourceWidth, sourceHeight, maxSide);
    const surface = size.width > 0 && size.height > 0 ? createSurface(size.width, size.height) : null;

    let mask: CachedMask | null = null;
    if (surface) {
      const { context } = surface;
      // A fresh canvas starts transparent, so no clearRect is needed.
      context.globalCompositeOperation = 'source-over';
      context.drawImage(image, 0, 0, size.width, size.height);
      /*
        `source-in` is only safe on this isolated canvas: it keeps the fill colour
        where the image is opaque and clears the rest, which is exactly the mask
        we want. On the shared hit canvas the same operation would erase the
        layers underneath — see the module comment.
      */
      context.globalCompositeOperation = 'source-in';
      context.fillStyle = colorKey;
      context.fillRect(0, 0, size.width, size.height);
      context.globalCompositeOperation = 'source-over';
      mask = { canvas: surface.canvas, width: size.width, height: size.height };
      builds += 1;
      buildMs += now() - started;
    }

    byKey.set(key, mask);
    return mask;
  };

  return {
    paint(hit, target, image) {
      const { sourceWidth, sourceHeight, colorKey } = target;
      if (!(sourceWidth > 0) || !(sourceHeight > 0)) return;

      const mask = maskFor(image, sourceWidth, sourceHeight, colorKey);

      hit.save();
      hit.setAttr('globalCompositeOperation', 'source-over');
      if (mask) {
        hit.drawImage(mask.canvas, 0, 0, sourceWidth, sourceHeight);
      } else {
        hit.setAttr('fillStyle', colorKey);
        hit.fillRect(0, 0, sourceWidth, sourceHeight);
      }
      hit.restore();
    },
    get builds() {
      return builds;
    },
    get buildMs() {
      return buildMs;
    },
    clear() {
      cache = new WeakMap<object, Map<string, CachedMask | null>>();
      builds = 0;
      buildMs = 0;
    },
  };
}
