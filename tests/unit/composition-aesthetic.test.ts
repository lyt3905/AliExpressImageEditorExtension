/**
 * 成品观感：六个可算的数字 + 一条整体区间。
 *
 * 这一层的存在理由：上面每条规则都只管一张图（viewer 里各自"合格"），但拼起来可能
 * 糊成一片、可能空得像海报缩了一半、也可能三张一样大读不出主次。这里钉住三件事：
 * ① 度量只测量、不判断（同样的输入永远给同样的数）；② 整体缩放只动 support 位，
 * hero 由 hero_dominance 与包装盒可读性负责；③ 素材不够就报 `not_enough_pictures`，
 * 不许把一张"独苗"当成品。
 */

import { describe, expect, it } from 'vitest';
import COLLAGE_SOURCE from '../../src/services/composition/templates/three_pose_figure_collage_white.v1.0.json';
import { opaqueProfile } from '../../src/services/composition/alpha';
import { fitCanvasFill, type CanvasFillItem } from '../../src/services/composition/fit-canvas-fill';
import { measureLayout, unionArea } from '../../src/services/composition/measure-layout';
import { buildCompositionPlan, type PlannerMaterial } from '../../src/services/composition/planner';
import { parseLayoutTemplateOrThrow } from '../../src/services/composition/template-schema';
import type { CloseupSpec, Rect } from '../../src/services/composition/types';

const CANVAS = { width: 800, height: 800 };

function closeup(overrides: Partial<CloseupSpec> = {}): CloseupSpec {
  return {
    viewport: [0, 0, 800, 800],
    fit: 'height',
    zoom: 1,
    anchor: 'top_center',
    centerX: 400,
    clipToViewport: false,
    ...overrides,
  };
}

function picture(slotId: string, width: number, height: number, centerX: number, centerY: number, scale: number) {
  return { slotId, profile: opaqueProfile(width, height), placement: { centerX, centerY, scale } };
}

describe('measureLayout', () => {
  it('adds up two disjoint boxes without double counting', () => {
    const area = unionArea([
      [0, 0, 100, 100] as Rect,
      [100, 0, 200, 100] as Rect,
    ]);
    expect(area).toBe(20000);
  });

  it('counts the shared part of two overlapping boxes once', () => {
    const area = unionArea([
      [0, 0, 100, 100] as Rect,
      [50, 0, 150, 100] as Rect,
    ]);
    expect(area).toBe(15000);
  });

  it('reports the union, the tightest margin and the centroid of a two-figure layout', () => {
    // Two 200x400 figures side by side: left edge 100, right edge 700, top 100, bottom 500.
    const metrics = measureLayout({
      canvas: CANVAS,
      pictures: [
        picture('left', 200, 400, 200, 300, 1),
        picture('right', 200, 400, 600, 300, 1),
      ],
    });
    expect(metrics.union).toBeCloseTo((2 * 200 * 400) / (800 * 800), 3);
    expect(metrics.margins).toEqual({ left: 100, right: 100, top: 100, bottom: 300 });
    expect(metrics.minMargin).toBe(100);
    expect(metrics.hierarchy).toBeCloseTo(1, 2);
    expect(metrics.occlusion).toBe(0);
    expect(metrics.centroid.x).toBeCloseTo(0.5, 3);
  });

  it('measures how much one picture buries another', () => {
    const metrics = measureLayout({
      canvas: CANVAS,
      pictures: [picture('back', 400, 400, 400, 400, 1), picture('front', 400, 400, 600, 400, 1)],
    });
    // Ordered list = paint order, so `front` (later) hides half of `back`.
    expect(metrics.occlusion).toBeCloseTo(0.5, 3);
  });

  it('reports a picture that the canvas cuts off', () => {
    const metrics = measureLayout({
      canvas: CANVAS,
      pictures: [picture('spill', 400, 400, 0, 300, 1)],
    });
    expect(metrics.cropped).toBeCloseTo(0.5, 2);
    expect(metrics.margins.left).toBe(0);
  });
});

describe('fitCanvasFill', () => {
  /** 400x800 opaque figure at zoom 1 → exactly 800 px tall, 400 wide → half the canvas. */
  const item = (slotId: string, zoom = 1, shape: [number, number] = [400, 800]): CanvasFillItem => ({
    slotId,
    profile: opaqueProfile(shape[0], shape[1]),
    closeup: closeup(),
    zoom,
  });

  it('leaves a layout that already sits inside the band alone', () => {
    const outcome = fitCanvasFill({
      // 400x800 at 0.75 → 300x600 = 0.28 of the canvas, comfortably inside [0.2, 0.8].
      items: [item('a', 0.75)],
      fixed: [],
      canvas: CANVAS,
      rule: { minUnion: 0.2, maxUnion: 0.8, minHierarchy: 1.1 },
    });
    expect(outcome.scaledBy).toBe(1);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.metrics.union).toBeCloseTo(0.28, 2);
  });

  it('shrinks the page back into the band when it is too full', () => {
    const outcome = fitCanvasFill({
      items: [item('a'), item('b', 1, [400, 800])],
      fixed: [],
      canvas: CANVAS,
      rule: { minUnion: 0.1, maxUnion: 0.4, minHierarchy: 1 },
    });
    expect(outcome.scaledBy).toBeLessThan(1);
    expect(outcome.metrics.union).toBeLessThanOrEqual(0.44);
  });

  it('grows the page when it is too empty', () => {
    const outcome = fitCanvasFill({
      items: [item('a', 0.3)],
      fixed: [],
      canvas: CANVAS,
      rule: { minUnion: 0.3, maxUnion: 0.9, minHierarchy: 1 },
    });
    expect(outcome.scaledBy).toBeGreaterThan(1);
    expect(outcome.metrics.union).toBeGreaterThan(0.28);
  });

  it('gives the smallest picture a smaller zoom so the hierarchy reads', () => {
    const outcome = fitCanvasFill({
      items: [item('big', 0.8), item('small', 0.5)],
      fixed: [],
      canvas: CANVAS,
      rule: { minUnion: 0.05, maxUnion: 0.95, minHierarchy: 1.35 },
    });
    const big = outcome.items.find((entry) => entry.slotId === 'big')!;
    const small = outcome.items.find((entry) => entry.slotId === 'small')!;
    // 层级达标，且缩的是小的那一张 —— 大的那个不许因为"收窄整页"被顺手改小。
    expect(outcome.metrics.hierarchy).toBeGreaterThanOrEqual(1.35);
    expect(big.zoom).toBeCloseTo(0.8, 6);
    expect(small.occupancy).toBeLessThan(big.occupancy);
  });

  it('says so when the floor keeps the hierarchy flat', () => {
    // Two identical items, hierarchy floor unreachable because both hit the same bounds.
    const outcome = fitCanvasFill({
      items: [item('a', 1), item('b', 1)],
      fixed: [],
      canvas: CANVAS,
      rule: { minUnion: 0.05, maxUnion: 0.95, minHierarchy: 3 },
    });
    // 只收到地板就停：要么层级达标，要么把话说清楚，不许假装没这回事。
    if (outcome.metrics.hierarchy < 2.98) {
      expect(outcome.warnings.some((entry) => entry.code === 'hierarchy_flat')).toBe(true);
    }
  });
});

describe('buildCompositionPlan — 整体观感与图片底线', () => {
  const TEMPLATE = parseLayoutTemplateOrThrow(COLLAGE_SOURCE);

  function material(id: string, width: number, height: number): PlannerMaterial {
    return {
      materialId: `material-${id}`,
      blobId: `blob-${id}`,
      kind: 'cutout',
      profile: opaqueProfile(width, height),
      label: id,
    };
  }

  it('refuses to compose a single picture when the template asks for two', () => {
    const built = buildCompositionPlan({
      template: TEMPLATE,
      hero: material('hero', 900, 1800),
    });
    expect(built.images).toEqual([]);
    const refusal = built.warnings.find((entry) => entry.code === 'not_enough_pictures');
    expect(refusal).toBeDefined();
    expect(refusal!.message).toContain('2');
  });

  it('composes two pictures and books the union and the six numbers', () => {
    const built = buildCompositionPlan({
      template: TEMPLATE,
      hero: material('hero', 900, 1800),
      supports: [{ slotId: 'rear_view_background', material: material('rear', 700, 1400) }],
    });
    expect(built.images).toHaveLength(2);
    expect(built.warnings.some((entry) => entry.code === 'not_enough_pictures')).toBe(false);
    const union = built.diagnostics.canvasFill;
    expect(union).toBeDefined();
    expect(union!.union).toBeGreaterThan(0);
    const aesthetic = built.diagnostics.aesthetic;
    expect(aesthetic).toBeDefined();
    expect(aesthetic!.union).toBeGreaterThan(0);
    expect(aesthetic!.hierarchy).toBeGreaterThanOrEqual(1);
    expect(aesthetic!.centroid.x).toBeGreaterThan(0);
  });
});
