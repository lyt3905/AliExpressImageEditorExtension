/**
 * Real alpha outline for picture layers (10.23.0).
 *
 * A glow in this project used to be "the same picture again, tinted, with a big
 * shadow" (see `EditorStage`): cheap, and fine for a halo, but it cannot produce a
 * crisp rim — Konva has no morphological dilation, so the hard edge of a shadow
 * copy is the picture's own silhouette, not a band *outside* it. Poster layouts
 * need the band: a 4px red outline hugging the subject is what separates it from
 * a dark background.
 *
 * So the rim is computed here, once per (image, parameters) pair, on a capped
 * working bitmap:
 *
 *   A = alpha mask          (alpha >= 128 counts as inside)
 *   D = distance from each  outside pixel to the nearest inside pixel
 *   rim   = D <= width                     → fully opaque, chosen colour
 *   halo  = width < D <= width + glow      → smoothstep falloff
 *
 * The distance transform is the chamfer 3-4 approximation (two passes, O(n));
 * exact Euclidean is not worth a second pass over 262k pixels for a 512px preview.
 * Output includes padding on all four sides, because a rim drawn *outside* the
 * picture is clipped by the picture's own box otherwise.
 */
import type { ImageEffects } from '../shared/types';

/** Longest side of the working bitmap. Preview only needs "looks right at 800px". */
export const OUTLINE_WORK_MAX = 512;

export interface OutlineSpec {
  /** Rim thickness in work-bitmap pixels. */
  width: number;
  /** Additional soft falloff outside the rim, work-bitmap pixels. */
  glow: number;
  /** `#rrggbb`. */
  color: string;
  /** 0–1; multiplies both rim and halo. */
  opacity: number;
}

export interface OutlinePixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** Padding added on every side, in work-bitmap pixels. */
  pad: number;
}

/** Whether this effect block asks for an alpha outline at all. */
export function outlineSpecOf(effects: ImageEffects): OutlineSpec | null {
  const width = Math.max(0, effects.outlineWidth ?? 0);
  const glow = Math.max(0, effects.outlineGlow ?? 0);
  const opacity = Math.min(1, Math.max(0, effects.outlineOpacity ?? 0));
  if (width <= 0 || opacity <= 0) return null;
  return { width, glow, color: effects.outlineColor, opacity };
}

function hexToChannels(color: string): [number, number, number] {
  const body = color.replace('#', '');
  const full =
    body.length === 3
      ? `${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`
      : body.padEnd(6, '0').slice(0, 6);
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value)) return [255, 255, 255];
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Chamfer 3-4 distance transform: distance from outside pixels to the nearest
 * inside pixel. Inside pixels keep 0.
 */
function distanceToMask(mask: Uint8Array, width: number, height: number): Float32Array {
  const size = width * height;
  const distance = new Float32Array(size);
  const far = width + height + 2;
  for (let index = 0; index < size; index += 1) {
    distance[index] = mask[index] > 0 ? 0 : far;
  }
  const diagonal = Math.SQRT2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (distance[index] === 0) continue;
      let best = distance[index];
      if (x > 0) best = Math.min(best, distance[index - 1] + 1);
      if (y > 0) best = Math.min(best, distance[index - width] + 1);
      if (x > 0 && y > 0) best = Math.min(best, distance[index - width - 1] + diagonal);
      if (x + 1 < width && y > 0) best = Math.min(best, distance[index - width + 1] + diagonal);
      distance[index] = best;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const index = y * width + x;
      if (distance[index] === 0) continue;
      let best = distance[index];
      if (x + 1 < width) best = Math.min(best, distance[index + 1] + 1);
      if (y + 1 < height) best = Math.min(best, distance[index + width] + 1);
      if (x + 1 < width && y + 1 < height) best = Math.min(best, distance[index + width + 1] + diagonal);
      if (x > 0 && y + 1 < height) best = Math.min(best, distance[index + width - 1] + diagonal);
      distance[index] = best;
    }
  }
  return distance;
}

/**
 * Pure rim + halo rasteriser. Kept free of canvas/DOM so the geometry is testable
 * in Node — the DOM wrapper is `buildOutlineBitmap()` below.
 */
export function computeOutlinePixels(
  alpha: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  spec: OutlineSpec,
): OutlinePixels | null {
  if (width <= 0 || height <= 0 || alpha.length < width * height) return null;
  const mask = new Uint8Array(width * height);
  let inside = 0;
  for (let index = 0; index < mask.length; index += 1) {
    if (alpha[index] >= 128) {
      mask[index] = 1;
      inside += 1;
    }
  }
  // Nothing opaque: a rim around an empty picture would be a rectangle, not a
  // silhouette, and drawing it looks like a bug rather than an effect.
  if (inside === 0) return null;

  const distance = distanceToMask(mask, width, height);
  const pad = Math.ceil(spec.width + spec.glow) + 2;
  const outWidth = width + pad * 2;
  const outHeight = height + pad * 2;
  const data = new Uint8ClampedArray(outWidth * outHeight * 4);
  const [red, green, blue] = hexToChannels(spec.color);
  const rimEnd = spec.width;
  const haloEnd = spec.width + spec.glow;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const d = distance[y * width + x];
      if (d <= 0) continue; // inside the subject: the picture itself paints here
      let coverage = 0;
      if (d <= rimEnd) {
        coverage = 1;
      } else if (spec.glow > 0 && d <= haloEnd) {
        // smoothstep on the remaining distance: a linear ramp reads as a hard
        // second rim when the blur is small.
        const t = Math.min(1, Math.max(0, (haloEnd - d) / spec.glow));
        coverage = t * t * (3 - 2 * t) * 0.85;
      }
      if (coverage <= 0) continue;
      const target = ((y + pad) * outWidth + (x + pad)) * 4;
      data[target] = red;
      data[target + 1] = green;
      data[target + 2] = blue;
      data[target + 3] = Math.round(coverage * spec.opacity * 255);
    }
  }
  return { data, width: outWidth, height: outHeight, pad };
}

/**
 * Same as `computeOutlinePixels`, but from a decoded image and back into a canvas
 * the stage can hand to Konva. Returns `null` when the effect is off or the
 * picture has no opaque pixels.
 */
export function buildOutlineBitmap(
  image: CanvasImageSource & { width: number; height: number },
  spec: OutlineSpec,
  workMax: number = OUTLINE_WORK_MAX,
): { canvas: HTMLCanvasElement; pad: number; scale: number } | null {
  const sourceWidth = Number(image.width) || 0;
  const sourceHeight = Number(image.height) || 0;
  if (sourceWidth <= 0 || sourceHeight <= 0) return null;
  const scale = Math.min(1, workMax / Math.max(sourceWidth, sourceHeight));
  const workWidth = Math.max(1, Math.round(sourceWidth * scale));
  const workHeight = Math.max(1, Math.round(sourceHeight * scale));

  const work = document.createElement('canvas');
  work.width = workWidth;
  work.height = workHeight;
  const workContext = work.getContext('2d', { willReadFrequently: true });
  if (!workContext) return null;
  workContext.clearRect(0, 0, workWidth, workHeight);
  workContext.drawImage(image, 0, 0, workWidth, workHeight);
  const { data: source } = workContext.getImageData(0, 0, workWidth, workHeight);
  const alpha = new Uint8ClampedArray(workWidth * workHeight);
  for (let index = 0; index < alpha.length; index += 1) alpha[index] = source[index * 4 + 3];

  const outline = computeOutlinePixels(alpha, workWidth, workHeight, spec);
  if (!outline) return null;

  const canvas = document.createElement('canvas');
  canvas.width = outline.width;
  canvas.height = outline.height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const imageData = context.createImageData(outline.width, outline.height);
  imageData.data.set(outline.data);
  context.putImageData(imageData, 0, 0);
  return { canvas, pad: outline.pad, scale: workWidth > 0 ? 1 / scale : 1 };
}

/**
 * Cache key for one outline bitmap: the picture, the working size and every
 * parameter that changes pixels. Two pictures with the same parameters must not
 * share an entry.
 */
export function outlineCacheKey(
  imageKey: string,
  spec: OutlineSpec,
  workMax: number = OUTLINE_WORK_MAX,
): string {
  return [
    'outline',
    imageKey,
    workMax,
    spec.width.toFixed(2),
    spec.glow.toFixed(2),
    spec.opacity.toFixed(3),
    spec.color.toLowerCase(),
  ].join('|');
}
