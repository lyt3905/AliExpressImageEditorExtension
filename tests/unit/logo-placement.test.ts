import { describe, expect, it } from 'vitest';

import {
  CANVAS_SIZE,
  LOGO_BOTTOM_RATIO,
  LOGO_DEFAULT_LONGEST_RATIO,
  LOGO_MARGIN,
  LOGO_MAX_SCALE,
  LOGO_MIN_SCALE,
} from '../../src/shared/constants';
import {
  defaultLogoPlacement,
  parseLogoPlacementMap,
} from '../../src/services/logo-placement';

describe('defaultLogoPlacement', () => {
  it('puts the logo at the right edge, above the bottom banner strip', () => {
    const placement = defaultLogoPlacement(400, 200);
    const scale = (CANVAS_SIZE * LOGO_DEFAULT_LONGEST_RATIO) / 400;
    // (x, y) is the CENTRE, so it sits half a scaled logo away from the edge.
    expect(placement.scale).toBeCloseTo(scale, 10);
    expect(placement.x).toBeCloseTo(CANVAS_SIZE - LOGO_MARGIN - (400 * scale) / 2, 6);
    expect(placement.y).toBeCloseTo(
      CANVAS_SIZE - CANVAS_SIZE * LOGO_BOTTOM_RATIO - (200 * scale) / 2,
      6,
    );
  });

  it('leaves the bottom strip free: the logo bottom edge clears LOGO_BOTTOM_RATIO', () => {
    const placement = defaultLogoPlacement(400, 200);
    const bottomEdge = placement.y + (200 * placement.scale) / 2;
    expect(bottomEdge).toBeCloseTo(CANVAS_SIZE * (1 - LOGO_BOTTOM_RATIO), 6);
    // The strip sellers put a bottom banner in stays empty.
    expect(bottomEdge).toBeLessThan(CANVAS_SIZE);
    expect(CANVAS_SIZE - bottomEdge).toBeGreaterThanOrEqual(CANVAS_SIZE * 0.15);
  });

  it('scales the longest side to the ratio of the canvas, not the width', () => {
    const tall = defaultLogoPlacement(100, 400);
    expect(tall.scale).toBeCloseTo((CANVAS_SIZE * LOGO_DEFAULT_LONGEST_RATIO) / 400, 10);
  });

  it('keeps a logo of one pixel from blowing up the scale', () => {
    const tiny = defaultLogoPlacement(1, 1);
    expect(tiny.scale).toBeCloseTo(CANVAS_SIZE * LOGO_DEFAULT_LONGEST_RATIO, 6);
  });

  it('falls back to the canvas size when the source size is unknown', () => {
    expect(defaultLogoPlacement(0, 0)).toEqual(defaultLogoPlacement(CANVAS_SIZE, CANVAS_SIZE));
  });
});

describe('parseLogoPlacementMap', () => {
  it('reads a well-formed map back', () => {
    const map = parseLogoPlacementMap({
      bandai: { x: 100, y: 200, scale: 0.5 },
      fansToys: { x: 10, y: 20, scale: 2 },
    });
    expect(map).toEqual({
      bandai: { x: 100, y: 200, scale: 0.5 },
      fansToys: { x: 10, y: 20, scale: 2 },
    });
  });

  it('returns an empty map for anything that is not an object', () => {
    for (const bad of [null, undefined, 42, 'x', [], true]) {
      expect(parseLogoPlacementMap(bad)).toEqual({});
    }
  });

  it('drops entries that are missing x / y / scale or not an object', () => {
    const map = parseLogoPlacementMap({
      noX: { y: 1, scale: 1 },
      noY: { x: 1, scale: 1 },
      noScale: { x: 1, y: 2 },
      nanScale: { x: 1, y: 2, scale: Number.NaN },
      notObject: 'nope',
      ok: { x: 3, y: 4, scale: 0.25 },
    });
    expect(Object.keys(map)).toEqual(['ok']);
  });

  it('clamps a scale that is out of range', () => {
    const map = parseLogoPlacementMap({
      huge: { x: 0, y: 0, scale: 999 },
      tiny: { x: 0, y: 0, scale: 0.0000001 },
    });
    expect(map.huge?.scale).toBe(LOGO_MAX_SCALE);
    expect(map.tiny?.scale).toBe(LOGO_MIN_SCALE);
  });

  it('ignores an empty brand id', () => {
    expect(parseLogoPlacementMap({ '': { x: 1, y: 1, scale: 1 } })).toEqual({});
  });
});
