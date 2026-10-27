/**
 * Turn raw RGBA pixels into an `AlphaProfile`.
 *
 * Kept separate from the browser probe so the interesting half is testable: this
 * function takes a plain pixel array and has no idea whether it came from an
 * `OffscreenCanvas`, a file, or a test fixture.
 *
 * Two passes on purpose. The first finds the opaque bounding box (the cut-out
 * canvas is mostly empty — that empty margin is what makes naive scaling shrink
 * every product). The second fills an N×N coverage mask *inside* that box, which
 * is the only shape information the solver ever needs.
 */

import type { AlphaProfile, TrimBox } from './alpha';
import { createAlphaProfile } from './alpha';

export interface AlphaScanOptions {
  /** Mask resolution; 128 keeps a 1600px product's silhouette to ~5px cells. */
  maskSize?: number;
  /** Alpha (0-255) below this counts as transparent. Guards against JPEG-ish fuzz. */
  threshold?: number;
}

export interface AlphaScan {
  trim: TrimBox;
  maskSize: number;
  mask: number[];
  density: number;
}

const DEFAULT_MASK_SIZE = 128;
const DEFAULT_THRESHOLD = 8;

/**
 * Scan RGBA pixels. Returns null when nothing is visible — an empty cut-out must
 * fail loudly at the call site rather than produce a zero-area profile that later
 * divides by zero.
 */
export function scanAlpha(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  options: AlphaScanOptions = {},
): AlphaScan | null {
  const maskSize = Math.max(1, Math.floor(options.maskSize ?? DEFAULT_MASK_SIZE));
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`scanAlpha: 尺寸非法 ${width}×${height}`);
  }
  if (pixels.length < width * height * 4) {
    throw new Error(`scanAlpha: 像素数量不足，期望 ${width * height * 4}，实际 ${pixels.length}`);
  }

  // ---- pass 1: bounding box of anything visible --------------------------
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if ((pixels[(y * width + x) * 4 + 3] ?? 0) > threshold) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < left || bottom < top) return null;

  const trim: TrimBox = { left, top, width: right - left + 1, height: bottom - top + 1 };

  // ---- pass 2: coverage inside the box -----------------------------------
  const sums = new Float64Array(maskSize * maskSize);
  const counts = new Uint32Array(maskSize * maskSize);

  for (let y = top; y <= bottom; y += 1) {
    const row = Math.min(maskSize - 1, Math.floor(((y - top) / trim.height) * maskSize));
    for (let x = left; x <= right; x += 1) {
      const column = Math.min(maskSize - 1, Math.floor(((x - left) / trim.width) * maskSize));
      const cell = row * maskSize + column;
      sums[cell] += (pixels[(y * width + x) * 4 + 3] ?? 0) / 255;
      counts[cell] += 1;
    }
  }

  const mask = new Array<number>(maskSize * maskSize);
  let total = 0;
  for (let cell = 0; cell < mask.length; cell += 1) {
    const count = counts[cell] ?? 0;
    const coverage = count > 0 ? (sums[cell] ?? 0) / count : 0;
    mask[cell] = coverage;
    total += coverage;
  }

  return { trim, maskSize, mask, density: total / mask.length };
}

/** Convenience: scan and wrap into the profile the solver consumes. */
export function profileFromPixels(
  pixels: ArrayLike<number>,
  width: number,
  height: number,
  options: AlphaScanOptions & { sourceWidth?: number; sourceHeight?: number; scale?: number } = {},
): AlphaProfile | null {
  const scan = scanAlpha(pixels, width, height, options);
  if (!scan) return null;

  // `scale` maps scanned pixels back to source pixels; the probe scans a
  // downscaled copy, so the trim box must be reported in ORIGINAL units.
  const scale = options.scale ?? 1;
  const sourceWidth = options.sourceWidth ?? width;
  const sourceHeight = options.sourceHeight ?? height;
  const inverse = scale > 0 ? 1 / scale : 1;

  // Round the two EDGES of the box, not the origin and the size. Rounding both
  // independently lets them drift apart: a real cut-out (1600×1600 scanned at
  // 512, so ×3.125) had its top edge at 4 → 12.5 → 13 and its height at 508 →
  // 1587.5 → 1588, and 13 + 1588 = 1601 — one pixel past the source, which the
  // profile contract rejects ("trim 超出源尺寸"), so generating failed outright.
  // Clamping after the fact would still leave a box that is half a scan pixel
  // off; rounding edges keeps the box exactly as wide as the pixels found.
  const trim: TrimBox = {
    left: clamp(Math.round(scan.trim.left * inverse), 0, sourceWidth - 1),
    top: clamp(Math.round(scan.trim.top * inverse), 0, sourceHeight - 1),
    width: 0,
    height: 0,
  };
  trim.width =
    clamp(Math.round((scan.trim.left + scan.trim.width) * inverse), trim.left + 1, sourceWidth) -
    trim.left;
  trim.height =
    clamp(Math.round((scan.trim.top + scan.trim.height) * inverse), trim.top + 1, sourceHeight) -
    trim.top;

  return createAlphaProfile({
    sourceWidth,
    sourceHeight,
    maskSize: scan.maskSize,
    mask: scan.mask,
    trim,
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
