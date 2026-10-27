import { describe, expect, it } from 'vitest';
import { scanAlpha, profileFromPixels } from '../../src/services/composition/alpha-scan';

/** Build an RGBA buffer with a reusable painter. */
function canvas(width: number, height: number) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  return {
    pixels,
    fill(x0: number, y0: number, x1: number, y1: number, alpha: number) {
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const offset = (y * width + x) * 4;
          pixels[offset] = 30;
          pixels[offset + 1] = 90;
          pixels[offset + 2] = 200;
          pixels[offset + 3] = alpha;
        }
      }
    },
  };
}

describe('scanAlpha', () => {
  it('finds the opaque bounding box', () => {
    const image = canvas(8, 8);
    image.fill(2, 3, 6, 7, 255);
    const scan = scanAlpha(image.pixels, 8, 8, { maskSize: 2 })!;
    expect(scan.trim).toEqual({ left: 2, top: 3, width: 4, height: 4 });
    expect(scan.density).toBe(1);
    expect(scan.mask).toEqual([1, 1, 1, 1]);
  });

  it('averages partial alpha into coverage', () => {
    const image = canvas(4, 4);
    image.fill(0, 0, 2, 4, 255);
    image.fill(2, 0, 4, 4, 128);
    const scan = scanAlpha(image.pixels, 4, 4, { maskSize: 2 })!;
    // Left column solid, right column ~0.502.
    expect(scan.mask[0]).toBeCloseTo(1, 6);
    expect(scan.mask[1]).toBeCloseTo(128 / 255, 4);
    expect(scan.density).toBeGreaterThan(0.7);
    expect(scan.density).toBeLessThan(0.8);
  });

  it('ignores alpha below the threshold', () => {
    const image = canvas(4, 4);
    image.fill(0, 0, 4, 4, 4);
    expect(scanAlpha(image.pixels, 4, 4)).toBeNull();
  });

  it('returns null for a fully transparent image', () => {
    const image = canvas(16, 16);
    expect(scanAlpha(image.pixels, 16, 16)).toBeNull();
  });

  it('handles a single visible pixel', () => {
    const image = canvas(5, 5);
    image.fill(3, 1, 4, 2, 255);
    const scan = scanAlpha(image.pixels, 5, 5, { maskSize: 3 })!;
    expect(scan.trim).toEqual({ left: 3, top: 1, width: 1, height: 1 });
    expect(scan.mask.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
  });

  it('rejects impossible inputs', () => {
    expect(() => scanAlpha(new Uint8ClampedArray(4), 0, 4)).toThrow(/尺寸非法/);
    expect(() => scanAlpha(new Uint8ClampedArray(4), 4, 4)).toThrow(/像素数量不足/);
  });
});

describe('profileFromPixels', () => {
  it('reports the trim box in source pixels when scanned downscaled', () => {
    // 4x4 scan of an 8x8 source: the trim box must double.
    const image = canvas(4, 4);
    image.fill(1, 1, 3, 3, 255);
    const profile = profileFromPixels(image.pixels, 4, 4, {
      maskSize: 2,
      scale: 0.5,
      sourceWidth: 8,
      sourceHeight: 8,
    })!;
    expect(profile.trim).toEqual({ left: 2, top: 2, width: 4, height: 4 });
    expect(profile.sourceWidth).toBe(8);
    expect(profile.maskSize).toBe(2);
  });

  it('returns null instead of a zero-area profile', () => {
    const image = canvas(4, 4);
    expect(profileFromPixels(image.pixels, 4, 4)).toBeNull();
  });

  it('keeps the trim box inside the source when both ends round up', () => {
    // Reported in the wild: a 1600×1600 cut-out scanned at 512 (×3.125), with
    // opaque rows 4..511 and columns 112..459. Rounding the origin and the size
    // separately gave top 12.5→13 and height 1587.5→1588, so 13+1588 = 1601 —
    // one pixel past the source — and every 生成主图 died with
    // "AlphaProfile: trim … 超出源尺寸 1600×1600".
    const image = canvas(512, 512);
    image.fill(112, 4, 460, 512, 255);
    const profile = profileFromPixels(image.pixels, 512, 512, {
      maskSize: 8,
      scale: 512 / 1600,
      sourceWidth: 1600,
      sourceHeight: 1600,
    })!;

    expect(profile.trim).toEqual({ left: 350, top: 13, width: 1088, height: 1587 });
    expect(profile.trim.top + profile.trim.height).toBe(1600);
    expect(profile.trim.left + profile.trim.width).toBe(1438);
  });

  it('never reports a box outside the source, at any scan scale', () => {
    for (const side of [1600, 1080, 999, 700, 300]) {
      const scale = Math.min(1, 512 / side);
      const scanSide = Math.max(1, Math.round(side * scale));
      const image = canvas(scanSide, scanSide);
      image.fill(0, 0, scanSide, scanSide, 255);

      const profile = profileFromPixels(image.pixels, scanSide, scanSide, {
        maskSize: 4,
        scale,
        sourceWidth: side,
        sourceHeight: side,
      })!;

      expect(profile.trim.left).toBe(0);
      expect(profile.trim.top).toBe(0);
      expect(profile.trim.left + profile.trim.width).toBeLessThanOrEqual(side);
      expect(profile.trim.top + profile.trim.height).toBeLessThanOrEqual(side);
      expect(profile.trim.width).toBeGreaterThan(0);
      expect(profile.trim.height).toBeGreaterThan(0);
    }
  });
});
