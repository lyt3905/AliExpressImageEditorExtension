/**
 * Browser-side alpha probe.
 *
 * The only impure part of the composition pipeline: decode a blob, draw it small,
 * read the pixels, hand them to `scanAlpha`. Everything interesting lives in
 * `alpha-scan.ts` so it can be unit-tested without a canvas.
 *
 * Scanning happens on a downscaled copy (512px by default). A 1600×1600 cut-out is
 * 2.5M pixels; at 512 it is 262k, and a bounding box that is off by one scanned
 * pixel is off by ~3 source pixels — irrelevant when the number is used to compute
 * a scale around 0.3.
 */

import { profileFromPixels } from './alpha-scan';
import type { AlphaProfile } from './alpha';

export interface AlphaProbeOptions {
  /** Mask resolution. */
  maskSize?: number;
  /** Longest side of the scan copy. */
  maxScanSide?: number;
  /** Alpha 0-255 below which a pixel counts as transparent. */
  threshold?: number;
}

export async function probeAlphaProfile(blob: Blob, options: AlphaProbeOptions = {}): Promise<AlphaProfile> {
  const maxScanSide = options.maxScanSide ?? 512;
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxScanSide / Math.max(bitmap.width, bitmap.height));
    const scanWidth = Math.max(1, Math.round(bitmap.width * scale));
    const scanHeight = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(scanWidth, scanHeight);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('无法创建 2D 上下文，无法分析素材透明度');

    // A transparent backdrop on purpose: `drawImage` composites onto whatever is
    // already there, and an opaque default would erase the alpha channel that this
    // whole function exists to measure.
    context.clearRect(0, 0, scanWidth, scanHeight);
    context.drawImage(bitmap, 0, 0, scanWidth, scanHeight);

    const pixels = context.getImageData(0, 0, scanWidth, scanHeight).data;
    const profile = profileFromPixels(pixels, scanWidth, scanHeight, {
      maskSize: options.maskSize,
      threshold: options.threshold,
      scale,
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
    });
    if (!profile) throw new Error('抠图结果里没有可见像素');
    return profile;
  } finally {
    bitmap.close();
  }
}

/** Per-session memo so re-generating a plan does not re-scan every material. */
export function createAlphaProbeCache(): {
  probe: (blobId: string, blob: Blob) => Promise<AlphaProfile>;
  clear: () => void;
} {
  const cache = new Map<string, Promise<AlphaProfile>>();
  return {
    probe(blobId, blob) {
      const existing = cache.get(blobId);
      if (existing) return existing;
      const pending = probeAlphaProfile(blob).catch((error: unknown) => {
        // Drop the rejected promise: a failed scan must be retryable, otherwise one
        // transient decode error poisons the blob for the rest of the session.
        cache.delete(blobId);
        throw error;
      });
      cache.set(blobId, pending);
      return pending;
    },
    clear() {
      cache.clear();
    },
  };
}
