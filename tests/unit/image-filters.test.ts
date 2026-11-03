/**
 * Filters with REAL Konva, not just our normalisation.
 *
 * The 10.22.0 review found that every `image-effects` test passed while the
 * canvas painted pure white: the tests only checked that numbers were clamped,
 * never what Konva's filters do with them. These cases run the actual filter
 * functions from the installed Konva against a pixel buffer, so the semantics
 * are pinned by pixels instead of by an assumption in a comment.
 */

import { describe, expect, it } from 'vitest';
import { Brighten } from 'konva/lib/filters/Brighten';
import { Grayscale } from 'konva/lib/filters/Grayscale';
import { RGB } from 'konva/lib/filters/RGB';
import {
  colorChannels,
  glowCacheSignature,
  imageFilterNames,
  konvaBrightness,
  pictureCacheSignature,
} from '../../src/services/image-effects';

type FilterFn = (this: unknown, imageData: { data: Uint8ClampedArray }) => void;

/** Run a Konva filter over one pixel, with the attributes it reads on `this`. */
function applyPixel(
  filter: FilterFn,
  attrs: Record<string, unknown>,
  pixel: [number, number, number, number],
): number[] {
  const imageData = { data: new Uint8ClampedArray(pixel) };
  const node = {
    brightness: () => attrs.brightness ?? 0,
    red: () => attrs.red ?? 0,
    green: () => attrs.green ?? 0,
    blue: () => attrs.blue ?? 0,
    grayscale: () => attrs.grayscale ?? false,
  };
  filter.call(node, imageData);
  return Array.from(imageData.data);
}

describe('Konva filter semantics', () => {
  it('treats brightness 0 as neutral (offset, not multiplier)', () => {
    expect(applyPixel(Brighten as FilterFn, { brightness: 0 }, [120, 60, 20, 255])).toEqual([
      120, 60, 20, 255,
    ]);
  });

  it('adds brightness * 255 and clamps at white', () => {
    expect(applyPixel(Brighten as FilterFn, { brightness: 0.2 }, [120, 60, 20, 255])).toEqual([
      171, 111, 71, 255,
    ]);
    expect(applyPixel(Brighten as FilterFn, { brightness: 1 }, [120, 60, 20, 255])).toEqual([
      255, 255, 255, 255,
    ]);
  });

  it('normalises dark pixels when brightness is negative', () => {
    expect(applyPixel(Brighten as FilterFn, { brightness: -0.5 }, [120, 60, 20, 255])).toEqual([
      0, 0, 0, 255,
    ]);
  });

  it('greys pixels out no matter what the node attribute says', () => {
    // `Grayscale` takes no attributes — this is exactly why the filter may only
    // be in the array when the user asked for it.
    expect(
      applyPixel(Grayscale as FilterFn, { grayscale: false }, [120, 60, 20, 255]).slice(0, 3),
    ).toEqual([74, 74, 74]);
  });

  it('tints a pixel to a flat colour while keeping alpha (the glow copy)', () => {
    const tint = colorChannels('#ff0000');
    expect(
      applyPixel(RGB as FilterFn, { red: tint.red, green: tint.green, blue: tint.blue }, [
        120, 60, 20, 255,
      ]),
    ).toEqual([74, 0, 0, 255]);
  });
});

describe('image effects → Konva attributes', () => {
  it('passes the document brightness straight through', () => {
    expect(konvaBrightness({ brightness: 0.35 })).toBeCloseTo(0.35, 6);
    expect(konvaBrightness({})).toBe(0);
  });

  it('keeps the brightness-neutral picture unchanged by any filter', () => {
    // Document default + no grayscale must produce an empty filter list, i.e.
    // the picture is never desaturated or blown out just by having a block.
    expect(imageFilterNames({})).toEqual([]);
    expect(imageFilterNames({ brightness: 0, grayscale: false })).toEqual([]);
  });

  it('never adds Grayscale for a brightness-only picture', () => {
    expect(imageFilterNames({ brightness: 0.2 })).toEqual(['brighten']);
    const pixel = applyPixel(Brighten as FilterFn, { brightness: konvaBrightness({ brightness: 0.2 }) }, [
      120, 60, 20, 255,
    ]);
    expect(pixel).toEqual([171, 111, 71, 255]);
    expect(pixel[0]).not.toBe(pixel[1]);
  });

  it('adds both filters, in grayscale-then-brighten order, when asked', () => {
    expect(imageFilterNames({ grayscale: true, brightness: 0.2 })).toEqual([
      'grayscale',
      'brighten',
    ]);
    const grey = applyPixel(Grayscale as FilterFn, {}, [120, 60, 20, 255]);
    expect(grey.slice(0, 3)).toEqual([74, 74, 74]);
    const brightened = applyPixel(Brighten as FilterFn, { brightness: 0.2 }, [
      grey[0],
      grey[1],
      grey[2],
      grey[3],
    ]);
    expect(brightened).toEqual([125, 125, 125, 255]);
  });
});

describe('cache signatures cover everything Konva bakes', () => {
  const base = {
    grayscale: false,
    brightness: 0,
    shadowColor: '#000000',
    shadowBlur: 0,
    shadowOpacity: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  };

  it('changes when the shadow changes, even with no filter on', () => {
    const before = pictureCacheSignature(base);
    expect(pictureCacheSignature({ ...base, shadowBlur: 30 })).not.toBe(before);
    expect(pictureCacheSignature({ ...base, shadowOffsetX: 8, shadowOffsetY: 6 })).not.toBe(before);
    expect(pictureCacheSignature({ ...base, shadowColor: '#112233' })).not.toBe(before);
    expect(pictureCacheSignature({ ...base, shadowOpacity: 0.5 })).not.toBe(before);
  });

  it('changes when the pixel filters change and stays stable otherwise', () => {
    expect(pictureCacheSignature({ ...base, grayscale: true })).not.toBe(pictureCacheSignature(base));
    expect(pictureCacheSignature({ ...base, brightness: 0.1 })).not.toBe(pictureCacheSignature(base));
    expect(pictureCacheSignature({ ...base })).toBe(pictureCacheSignature({ ...base }));
  });

  it('covers the glow radius and blur, not just the colour', () => {
    const glow = { glowColor: '#ff0000', glowOpacity: 0.5, glowRadius: 6, glowBlur: 24 };
    expect(glowCacheSignature({ ...glow, glowRadius: 20 })).not.toBe(glowCacheSignature(glow));
    expect(glowCacheSignature({ ...glow, glowBlur: 60 })).not.toBe(glowCacheSignature(glow));
    expect(glowCacheSignature({ ...glow, glowOpacity: 0.9 })).not.toBe(glowCacheSignature(glow));
    expect(glowCacheSignature({ ...glow, glowColor: '#00ff00' })).not.toBe(glowCacheSignature(glow));
  });
});
