import { describe, expect, it } from 'vitest';
import {
  createAlphaProfile,
  isUniformMask,
  maskCoverage,
  opaqueProfile,
} from '../../src/services/composition/alpha';
import {
  canvasOccupancy,
  contentRect,
  contentExtent,
  coveredFraction,
  fromLayerPlacement,
  toLayerPlacement,
  visibleAlphaArea,
  type ContentPlacement,
} from '../../src/services/composition/coverage';

const CANVAS = { width: 800, height: 800 };

function place(centerX: number, centerY: number, scale: number): ContentPlacement {
  return { centerX, centerY, scale };
}

describe('createAlphaProfile', () => {
  it('computes density from the mask', () => {
    const profile = createAlphaProfile({
      sourceWidth: 100,
      sourceHeight: 100,
      maskSize: 2,
      mask: [1, 0.5, 0, 0.5],
    });
    expect(profile.density).toBeCloseTo(0.5, 6);
    expect(maskCoverage(profile, 0, 0)).toBe(1);
    expect(maskCoverage(profile, 1, 1)).toBe(0.5);
    expect(isUniformMask(profile)).toBe(false);
  });

  it('defaults to a fully opaque mask over the whole image', () => {
    const profile = opaqueProfile(640, 480);
    expect(profile.density).toBe(1);
    expect(profile.trim).toEqual({ left: 0, top: 0, width: 640, height: 480 });
    expect(isUniformMask(profile)).toBe(true);
  });

  it('returns a fresh mask array rather than aliasing the input', () => {
    const mask = [1, 1, 1, 1];
    const profile = createAlphaProfile({ sourceWidth: 10, sourceHeight: 10, maskSize: 2, mask });
    expect(profile.mask).not.toBe(mask);
  });

  it('clamps out-of-range coverage instead of propagating it', () => {
    const profile = createAlphaProfile({
      sourceWidth: 10,
      sourceHeight: 10,
      maskSize: 2,
      mask: [2, -1, Number.NaN, 0.5],
    });
    expect(profile.mask).toEqual([1, 0, 0, 0.5]);
  });

  it('rejects geometry it cannot trust', () => {
    expect(() => opaqueProfile(0, 100)).toThrow(/源尺寸/);
    expect(() =>
      createAlphaProfile({ sourceWidth: 10, sourceHeight: 10, maskSize: 3, mask: [1, 1] }),
    ).toThrow(/mask 长度/);
    expect(() =>
      createAlphaProfile({
        sourceWidth: 100,
        sourceHeight: 100,
        maskSize: 1,
        trim: { left: 90, top: 0, width: 20, height: 20 },
      }),
    ).toThrow(/trim/);
  });
});

describe('visibleAlphaArea', () => {
  const profile = opaqueProfile(1000, 2000);

  it('is the full content area when it fits inside the canvas', () => {
    // 1000x2000 at 0.2 -> 200x400 = 80 000.
    expect(visibleAlphaArea(profile, place(400, 400, 0.2), CANVAS)).toBeCloseTo(80_000, 6);
  });

  it('counts only the part inside the canvas', () => {
    // Content spans x 650..850, so 150 of its 200 px are visible.
    expect(visibleAlphaArea(profile, place(750, 400, 0.2), CANVAS)).toBeCloseTo(150 * 400, 6);
  });

  it('is zero when the content is fully outside', () => {
    expect(visibleAlphaArea(profile, place(1200, 400, 0.2), CANVAS)).toBe(0);
    expect(visibleAlphaArea(profile, place(400, -500, 0.2), CANVAS)).toBe(0);
  });

  it('weights cells by their alpha coverage', () => {
    // Only the top-left quadrant is opaque: a quarter of the content's area.
    const quarter = createAlphaProfile({
      sourceWidth: 1000,
      sourceHeight: 2000,
      maskSize: 2,
      mask: [1, 0, 0, 0],
    });
    expect(visibleAlphaArea(quarter, place(400, 400, 0.2), CANVAS)).toBeCloseTo(20_000, 6);
  });

  it('reports occupancy as a fraction of the canvas', () => {
    expect(canvasOccupancy(profile, place(400, 400, 0.2), CANVAS)).toBeCloseTo(80_000 / 640_000, 8);
  });
});

describe('coveredFraction', () => {
  const region: [number, number, number, number] = [385, 25, 765, 535];

  it('is 1 when the hero covers the whole region', () => {
    const hero = opaqueProfile(800, 800);
    expect(coveredFraction(hero, place(400, 400, 1), region, CANVAS)).toBeCloseTo(1, 6);
  });

  it('reports the exact overlap share', () => {
    // Hero occupies x 0..400; the region starts at 385, so 15 of its 380 px.
    const hero = opaqueProfile(400, 800);
    const expected = (15 * 510) / (380 * 510);
    expect(coveredFraction(hero, place(200, 400, 1), region, CANVAS)).toBeCloseTo(expected, 6);
  });

  it('is 0 when the hero and the region do not touch', () => {
    const hero = opaqueProfile(200, 200);
    expect(coveredFraction(hero, place(100, 100, 1), region, CANVAS)).toBe(0);
  });

  it('treats the un-covered area outside the canvas as visible (conservative)', () => {
    const hero = opaqueProfile(800, 800);
    const hanging: [number, number, number, number] = [700, 0, 900, 200];
    // Denominator is the full 200x200 region, so the 100px outside the canvas
    // dilutes the result rather than inflating it.
    expect(coveredFraction(hero, place(400, 400, 1), hanging, CANVAS)).toBeCloseTo(0.5, 6);
  });
});

describe('trim fold-in', () => {
  // A 1000x2000 photo whose product sits in a 300x400 patch away from centre —
  // the usual shape of a cut-out PNG.
  const profile = createAlphaProfile({
    sourceWidth: 1000,
    sourceHeight: 2000,
    maskSize: 1,
    trim: { left: 100, top: 200, width: 300, height: 400 },
  });

  it('pushes the node away from the requested centre by the trim offset', () => {
    const layer = toLayerPlacement(profile, place(400, 400, 0.5));
    // Trim centre (250, 400) vs image centre (500, 1000) -> offset (-250, -600).
    expect(layer).toEqual({ x: 525, y: 700, scale: 0.5 });
  });

  it('round-trips back to the content placement', () => {
    const placement = place(321, 654, 0.37);
    const restored = fromLayerPlacement(profile, toLayerPlacement(profile, placement));
    expect(restored.centerX).toBeCloseTo(placement.centerX, 9);
    expect(restored.centerY).toBeCloseTo(placement.centerY, 9);
    expect(restored.scale).toBe(placement.scale);
  });

  it('is a no-op for a centred trim', () => {
    const centred = createAlphaProfile({
      sourceWidth: 1000,
      sourceHeight: 1000,
      maskSize: 1,
      trim: { left: 250, top: 250, width: 500, height: 500 },
    });
    expect(toLayerPlacement(centred, place(400, 400, 0.6))).toEqual({ x: 400, y: 400, scale: 0.6 });
  });

  it('sizes the content from the trim, not from the source canvas', () => {
    expect(contentExtent(profile, 0.5)).toEqual({ width: 150, height: 200 });
    expect(contentRect(profile, place(400, 400, 0.5))).toEqual([325, 300, 475, 500]);
  });
});
