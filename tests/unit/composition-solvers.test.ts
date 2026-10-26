import { describe, expect, it } from 'vitest';
import SOURCE from '../../src/services/composition/templates/hero_closeup_package_backdrop.v1.4.json';
import { createAlphaProfile, opaqueProfile } from '../../src/services/composition/alpha';
import { contentRect, canvasOccupancy } from '../../src/services/composition/coverage';
import { parseLayoutTemplateOrThrow } from '../../src/services/composition/template-schema';
import { heroPlacement, solveHero } from '../../src/services/composition/solve-hero';
import { solveBox, stableHash } from '../../src/services/composition/solve-box';
import {
  fitTextToBox,
  parseFontStyleSpec,
  textLayerGeometry,
  type MeasureText,
} from '../../src/services/composition/text-fit';

const TEMPLATE = parseLayoutTemplateOrThrow(SOURCE);
const HERO_SLOT = TEMPLATE.slots.find((slot) => slot.role === 'hero')!;
const BOX_SLOT = TEMPLATE.slots.find((slot) => slot.role === 'box')!;
const CLOSEUP = HERO_SLOT.closeup!;
const CANVAS = { width: TEMPLATE.canvas.width, height: TEMPLATE.canvas.height };

/** A tall product photo, the shape this template was tuned for (1:2). */
const TALL = opaqueProfile(1000, 2000);

function solve(profile = TALL) {
  return solveHero({
    profile,
    closeup: CLOSEUP,
    canvas: CANVAS,
    dominance: TEMPLATE.rules.heroDominance,
  });
}

describe('solveHero — anchor invariants', () => {
  it('pins the content top edge to the viewport top at every zoom', () => {
    for (const zoom of [1, 1.6, 2.2, 4]) {
      const rect = contentRect(TALL, heroPlacement(TALL, CLOSEUP, zoom));
      expect(rect[1]).toBeCloseTo(CLOSEUP.viewport[1], 9);
    }
  });

  it('keeps the horizontal centre at center_x, not the viewport centre', () => {
    const rect = contentRect(TALL, heroPlacement(TALL, CLOSEUP, 2.2));
    expect((rect[0] + rect[2]) / 2).toBeCloseTo(CLOSEUP.centerX, 9);
    // 300 is deliberately left of the viewport centre (400) — the close-up leans
    // left so the package keeps the right side.
    expect(CLOSEUP.centerX).toBeLessThan((CLOSEUP.viewport[0] + CLOSEUP.viewport[2]) / 2);
  });

  it('scales the trimmed height to the viewport height at zoom 1', () => {
    const rect = contentRect(TALL, heroPlacement(TALL, CLOSEUP, 1));
    expect(rect[3] - rect[1]).toBeCloseTo(CLOSEUP.viewport[3] - CLOSEUP.viewport[1], 6);
  });
});

describe('solveHero — hitting the occupancy band', () => {
  it('pulls a solid tall product down into the target band', () => {
    const solution = solve();
    expect(solution.occupancy).toBeGreaterThanOrEqual(0.36);
    expect(solution.occupancy).toBeLessThanOrEqual(0.46);
    // Nominal 2.2 would put ~56% of the canvas under a solid 1:2 product, so the
    // solver has to reduce it. It must say so.
    expect(solution.zoom).toBeLessThan(CLOSEUP.zoom);
    expect(solution.warnings.map((entry) => entry.code)).toContain('hero_zoom_reduced');
  });

  it('keeps the nominal zoom when the product is hollow enough', () => {
    // 75% alpha density at zoom 2.2 lands at ~0.42 occupancy — inside the band, so
    // the template's own number survives untouched.
    const hollow = createAlphaProfile({
      sourceWidth: 1000,
      sourceHeight: 2000,
      maskSize: 1,
      mask: [0.75],
    });
    const solution = solve(hollow);
    expect(solution.occupancy).toBeGreaterThanOrEqual(0.36);
    expect(solution.occupancy).toBeLessThanOrEqual(0.46);
    expect(Math.abs(solution.zoom - CLOSEUP.zoom)).toBeLessThan(0.1);
    expect(solution.warnings).toEqual([]);
  });

  it('reports a thin product it cannot lift to the floor', () => {
    const priceTag = createAlphaProfile({
      sourceWidth: 1000,
      sourceHeight: 2000,
      maskSize: 1,
      mask: [0.05],
    });
    const solution = solve(priceTag);
    expect(solution.occupancy).toBeLessThan(TEMPLATE.rules.heroDominance.minCanvasOccupancy);
    expect(solution.warnings.map((entry) => entry.code)).toContain('hero_occupancy_below_min');
  });

  it('is deterministic', () => {
    expect(solve()).toEqual(solve());
  });

  it('never leaves the zoom search bounds, and never zooms in past the template', () => {
    for (const profile of [TALL, opaqueProfile(2000, 2000), opaqueProfile(200, 3000)]) {
      const solution = solve(profile);
      expect(solution.zoom).toBeGreaterThanOrEqual(1);
      expect(solution.zoom).toBeLessThanOrEqual(CLOSEUP.zoom);
    }
  });

  it('does not raise the zoom to chase a sparse product', () => {
    // Zooming in would "fill the frame" only by cropping the product away. The
    // authored 2.2 is a ceiling; a sparse subject keeps it and gets a warning.
    const sparse = createAlphaProfile({
      sourceWidth: 1000,
      sourceHeight: 2000,
      maskSize: 1,
      mask: [0.55],
    });
    const solution = solve(sparse);
    expect(solution.zoom).toBeCloseTo(CLOSEUP.zoom, 2);
    expect(solution.occupancy).toBeLessThan(TEMPLATE.rules.heroDominance.minCanvasOccupancy);
    expect(solution.warnings.map((entry) => entry.code)).toContain('hero_occupancy_below_min');
  });

  it('can be told to raise the zoom anyway', () => {
    const sparse = createAlphaProfile({
      sourceWidth: 1000,
      sourceHeight: 2000,
      maskSize: 1,
      mask: [0.55],
    });
    const raised = solveHero({
      profile: sparse,
      closeup: CLOSEUP,
      canvas: CANVAS,
      dominance: TEMPLATE.rules.heroDominance,
      allowZoomRaise: true,
    });
    expect(raised.zoom).toBeGreaterThan(CLOSEUP.zoom);
    expect(raised.occupancy).toBeGreaterThanOrEqual(0.36);
  });

  it('squares the canvas coverage against a square solid product', () => {
    // A 1:1 product at nominal zoom covers ~77% of the canvas — far past the band.
    // This is the case the band cannot express, so it is worth pinning what
    // actually happens rather than pretending it fits.
    const square = opaqueProfile(2000, 2000);
    const nominal = heroPlacement(square, CLOSEUP, CLOSEUP.zoom);
    expect(canvasOccupancy(square, nominal, CANVAS)).toBeGreaterThan(0.7);
    expect(solve(square).occupancy).toBeLessThanOrEqual(0.46 + 1e-9);
  });
});

describe('solveBox — variant selection', () => {
  const boxProfile = opaqueProfile(800, 1000);

  it('picks the variant the hero hides least', () => {
    // Hero occupying x 0..600: every variant loses its left part, but not equally.
    const heroProfile = opaqueProfile(600, 800);
    const hero = { profile: heroProfile, placement: { centerX: 300, centerY: 400, scale: 1 } };
    const solution = solveBox({
      profile: boxProfile,
      variants: BOX_SLOT.variants!,
      canvas: CANVAS,
      minVisibleRatio: TEMPLATE.rules.packageReadability.minVisibleRatio,
      hero,
      seed: 'MTS-0001',
    })!;

    const best = Math.max(...solution.candidates.map((candidate) => candidate.visibleRatio));
    expect(solution.visibleRatio).toBeCloseTo(best, 9);
    // Variant 2 is the widest (390 at 570) and therefore the most exposed.
    expect(solution.variantIndex).not.toBe(2);
  });

  it('warns when every variant ends up buried', () => {
    const heroProfile = opaqueProfile(760, 800);
    const hero = { profile: heroProfile, placement: { centerX: 380, centerY: 400, scale: 1 } };
    const solution = solveBox({
      profile: boxProfile,
      variants: BOX_SLOT.variants!,
      canvas: CANVAS,
      minVisibleRatio: TEMPLATE.rules.packageReadability.minVisibleRatio,
      hero,
      seed: 'MTS-0001',
    })!;
    expect(solution.visibleRatio).toBeLessThan(TEMPLATE.rules.packageReadability.minVisibleRatio);
    expect(solution.warnings.map((entry) => entry.code)).toContain('box_visibility_below_min');
  });

  it('is fully visible without a hero and stable across runs', () => {
    const first = solveBox({
      profile: boxProfile,
      variants: BOX_SLOT.variants!,
      canvas: CANVAS,
      minVisibleRatio: 0.55,
      seed: 'MTS-0001',
    })!;
    expect(first.visibleRatio).toBe(1);
    const second = solveBox({
      profile: boxProfile,
      variants: BOX_SLOT.variants!,
      canvas: CANVAS,
      minVisibleRatio: 0.55,
      seed: 'MTS-0001',
    })!;
    expect(second.variantIndex).toBe(first.variantIndex);
  });

  it('lets the product code decide ties, so different products differ', () => {
    const indexes = new Set<number>();
    for (const seed of ['MTS-0001', 'MTS-0002', 'CM-0003', 'PS-0004', 'MTS-0005']) {
      const solution = solveBox({
        profile: boxProfile,
        variants: BOX_SLOT.variants!,
        canvas: CANVAS,
        minVisibleRatio: 0.55,
        seed,
      })!;
      indexes.add(solution.variantIndex);
    }
    // Not a hard guarantee for any single seed, but five seeds landing on one
    // variant would mean the hash is not doing its job.
    expect(indexes.size).toBeGreaterThan(1);
  });

  it('contains without stretching', () => {
    const solution = solveBox({
      profile: boxProfile,
      variants: BOX_SLOT.variants!,
      canvas: CANVAS,
      minVisibleRatio: 0.55,
    })!;
    const drawnWidth = boxProfile.trim.width * solution.placement.scale;
    const drawnHeight = boxProfile.trim.height * solution.placement.scale;
    expect(drawnWidth).toBeLessThanOrEqual(BOX_SLOT.variants![solution.variantIndex].maxSize[0] + 1e-9);
    expect(drawnHeight).toBeLessThanOrEqual(BOX_SLOT.variants![solution.variantIndex].maxSize[1] + 1e-9);
    expect(drawnWidth / drawnHeight).toBeCloseTo(800 / 1000, 9);
  });

  it('returns null when the template offers no variant', () => {
    expect(
      solveBox({
        profile: boxProfile,
        variants: [],
        canvas: CANVAS,
        minVisibleRatio: 0.55,
      }),
    ).toBeNull();
  });

  it('hashes stably', () => {
    expect(stableHash('MTS-0001')).toBe(stableHash('MTS-0001'));
    expect(stableHash('MTS-0001')).not.toBe(stableHash('MTS-0002'));
  });
});

/** 0.6 em per character — a stand-in for real glyph metrics. */
const measure: MeasureText = (text, font) => text.length * font.size * 0.6;

describe('fitTextToBox', () => {
  const zone = TEMPLATE.textZones[0];
  const base = {
    maxWidth: zone.box[2] - zone.box[0],
    maxHeight: zone.box[3] - zone.box[1],
    fontFamily: 'serif',
    weight: 'bold' as const,
    maxLines: zone.maxLines,
    minFontSize: 12,
    maxFontSize: 200,
    measure,
  };

  it('grows a short code to fill the zone', () => {
    const fit = fitTextToBox({ ...base, text: 'A7-BOX-88' });
    // 9 chars x 0.6 x size <= 340 -> size <= 62.96
    expect(fit.fits).toBe(true);
    expect(fit.fontSize).toBe(62);
    expect(fit.lines).toEqual(['A7-BOX-88']);
  });

  it('shrinks a long code instead of overflowing it', () => {
    const fit = fitTextToBox({ ...base, text: 'GX-2200-BLK-01-XL-PRO-MAX-PLUS-2' });
    expect(fit.fits).toBe(true);
    expect(fit.fontSize).toBeLessThan(30);
    expect(fit.lines).toHaveLength(1);
    expect(fit.width).toBeLessThanOrEqual(base.maxWidth);
  });

  it('admits defeat when even the minimum size overflows', () => {
    const fit = fitTextToBox({
      ...base,
      text: 'X'.repeat(80),
      maxWidth: 100,
      maxLines: 1,
    });
    expect(fit.fits).toBe(false);
    expect(fit.fontSize).toBe(12);
    expect(fit.lines).toHaveLength(1);
  });

  it('counts paragraphs as separate lines', () => {
    // maxLines comes from the zone (1 for the model code), so raise it here: this
    // case is about paragraph handling, not about the shipped zone.
    const fit = fitTextToBox({ ...base, text: 'ABC\nDEF', maxLines: 2, maxHeight: 400 });
    expect(fit.lines).toEqual(['ABC', 'DEF']);
    expect(fit.height).toBe(fit.fontSize * 2);
  });

  it('truncates to max_lines when the string needs more', () => {
    const fit = fitTextToBox({ ...base, text: 'ABC\nDEF', maxLines: 1, maxHeight: 400 });
    expect(fit.fits).toBe(false);
    expect(fit.lines).toEqual(['ABC']);
  });

  it('respects max_lines by wrapping', () => {
    const fit = fitTextToBox({
      ...base,
      text: 'ABCDEFGHIJ',
      maxWidth: 100,
      maxLines: 3,
      maxHeight: 400,
    });
    expect(fit.lines.length).toBeLessThanOrEqual(3);
    for (const line of fit.lines) {
      expect(measure(line, { family: 'serif', size: fit.fontSize, weight: 'bold' })).toBeLessThanOrEqual(100);
    }
  });
});

describe('parseFontStyleSpec / textLayerGeometry', () => {
  it('reads the shipped black_bold_serif spec', () => {
    expect(parseFontStyleSpec('black_bold_serif')).toEqual({
      family: 'serif',
      weight: 'bold',
      fill: '#000000',
    });
  });

  it('handles an unforeseen colour without throwing', () => {
    expect(parseFontStyleSpec('white_bold_sans').fill).toBe('#FFFFFF');
    expect(parseFontStyleSpec('neon_bold').fill).toBe('#000000');
  });

  it('puts the block flush with the zone and top-aligned', () => {
    const zoneSpec = TEMPLATE.textZones[0];
    const fit = fitTextToBox({
      text: 'A7-BOX-88',
      maxWidth: zoneSpec.box[2] - zoneSpec.box[0],
      maxHeight: zoneSpec.box[3] - zoneSpec.box[1],
      fontFamily: 'serif',
      weight: 'bold',
      maxLines: 1,
      minFontSize: 12,
      maxFontSize: 200,
      measure,
    });
    const geometry = textLayerGeometry(zoneSpec, fit);
    expect(geometry.width).toBe(340);
    // Node centre minus half the wrap width == the zone's left edge.
    expect(geometry.x - geometry.width / 2).toBeCloseTo(zoneSpec.box[0], 9);
    expect(geometry.y - fit.height / 2).toBeCloseTo(zoneSpec.box[1], 9);
    expect(geometry.align).toBe('left');
  });
});
