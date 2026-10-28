/**
 * Model-suggested occupancy: the one composition number the vision model owns.
 *
 * The rule these tests pin down: a `size` hint changes how big a picture reads,
 * never where it sits. The template still decides the viewport, the anchor and the
 * clipping, so the same answer always produces the same picture — and a hint the
 * geometry cannot honour comes back as a warning instead of a silently wrong layout.
 */

import { describe, expect, it } from 'vitest';
import COLLAGE_SOURCE from '../../src/services/composition/templates/three_pose_figure_collage_white.v1.0.json';
import { opaqueProfile } from '../../src/services/composition/alpha';
import { buildCompositionPlan, type PlannerMaterial } from '../../src/services/composition/planner';
import { solveSupportFill } from '../../src/services/composition/solve-fill';
import { parseLayoutTemplateOrThrow } from '../../src/services/composition/template-schema';
import { buildBindingPrompt, parseBindingAnswer } from '../../src/services/composition/vision-binder';
import type { CloseupSpec } from '../../src/services/composition/types';

const TEMPLATE = parseLayoutTemplateOrThrow(COLLAGE_SOURCE);
const CANVAS = { width: 800, height: 800 };

/** A full-bleed square closeup: at zoom 1 the content covers the whole canvas. */
const FULL_BLEED: CloseupSpec = {
  viewport: [0, 0, 800, 800],
  fit: 'height',
  zoom: 1,
  anchor: 'top_center',
  centerX: 400,
  clipToViewport: false,
};

function material(id: string, width: number, height: number): PlannerMaterial {
  return {
    materialId: `material-${id}`,
    blobId: `blob-${id}`,
    kind: 'cutout',
    profile: opaqueProfile(width, height),
    label: id,
  };
}

describe('solveSupportFill', () => {
  it('turns a target into a zoom that covers that share of the canvas', () => {
    const solved = solveSupportFill({
      profile: opaqueProfile(800, 800),
      closeup: FULL_BLEED,
      canvas: CANVAS,
      target: 0.25,
    });
    // Full-bleed square: occupancy is the square of the zoom, so 25 % means zoom 0.5.
    expect(solved.zoom).toBeCloseTo(0.5, 2);
    expect(solved.occupancy).toBeCloseTo(0.25, 2);
    expect(solved.clamped).toBe(false);
  });

  it('grows the content when the target grows', () => {
    const small = solveSupportFill({
      profile: opaqueProfile(800, 800),
      closeup: FULL_BLEED,
      canvas: CANVAS,
      target: 0.1,
    });
    const large = solveSupportFill({
      profile: opaqueProfile(800, 800),
      closeup: FULL_BLEED,
      canvas: CANVAS,
      target: 0.4,
    });
    expect(large.zoom).toBeGreaterThan(small.zoom);
    expect(large.occupancy).toBeGreaterThan(small.occupancy);
  });

  it('reports `clamped` when the zoom floor cannot make the content small enough', () => {
    const solved = solveSupportFill({
      profile: opaqueProfile(800, 800),
      closeup: FULL_BLEED,
      canvas: CANVAS,
      target: 0.05,
    });
    // The floor is 0.45 × nominal, i.e. 20 % of the canvas — far above the 5 % asked.
    expect(solved.zoom).toBeCloseTo(0.45, 6);
    expect(solved.occupancy).toBeGreaterThan(0.15);
    expect(solved.clamped).toBe(true);
  });

  it('reports `clamped` when the zoom ceiling cannot reach the target', () => {
    const solved = solveSupportFill({
      profile: opaqueProfile(800, 800),
      // A small viewport in a big canvas: even at the ceiling this covers ~30 %.
      closeup: { ...FULL_BLEED, viewport: [0, 0, 200, 200] },
      canvas: CANVAS,
      target: 0.6,
    });
    expect(solved.occupancy).toBeCloseTo(0.3025, 2);
    expect(solved.clamped).toBe(true);
  });
});

describe('planner honours the occupancy hints', () => {
  function plan(fills?: Record<string, number>) {
    return buildCompositionPlan({
      template: TEMPLATE,
      hero: material('hero', 1000, 2000),
      supports: [
        { slotId: 'rear_view_background', material: material('rear', 800, 1600) },
        { slotId: 'front_view_right', material: material('front', 900, 1800) },
      ],
      ...(fills ? { fills } : {}),
    });
  }

  it('keeps the template zoom when the model said nothing about sizes', () => {
    const built = plan();
    expect(built.diagnostics.fills).toBeUndefined();
    const rear = built.images.find((image) => image.slotId === 'rear_view_background')!;
    expect(rear.scale).toBeCloseTo(0.4813, 3);
  });

  it('sizes each picture slot separately, as asked', () => {
    // "The front view reads bigger than the back view" — the whole point of letting
    // the model answer sizes: a fixed template would give both the same treatment.
    const built = plan({ rear_view_background: 0.09, front_view_right: 0.25 });
    const rear = built.images.find((image) => image.slotId === 'rear_view_background')!;
    const front = built.images.find((image) => image.slotId === 'front_view_right')!;

    expect(rear.scale).toBeLessThan(front.scale);
    expect(built.diagnostics.fills?.rear_view_background.achieved).toBeCloseTo(0.09, 2);
    expect(built.diagnostics.fills?.front_view_right.achieved).toBeCloseTo(0.25, 2);
  });

  it('still keeps the horizontal position and the top anchor', () => {
    /*
      Only the size may move. `centerX` comes from the template, and the content's
      TOP edge is pinned to the viewport top, so a smaller picture sits higher —
      that is the anchor doing its job, not the solver drifting.
    */
    const nominal = plan();
    const sized = plan({ front_view_right: 0.25 });
    const before = nominal.images.find((image) => image.slotId === 'front_view_right')!;
    const after = sized.images.find((image) => image.slotId === 'front_view_right')!;
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeLessThanOrEqual(before.y);
    expect(after.scale).not.toBeCloseTo(before.scale, 3);
  });

  it('lets the hero hint move the preferred band without breaking the floor', () => {
    // 30 % is reachable by stepping the zoom down, so the hint is honoured silently.
    const built = plan({ action_pose_left_hero: 0.3 });
    const hero = built.images.find((image) => image.role === 'hero')!;
    expect(built.diagnostics.fills?.action_pose_left_hero.achieved).toBeCloseTo(0.3, 1);
    expect(built.warnings.some((entry) => entry.code === 'hero_fill_unmet')).toBe(false);
    expect(hero.scale).toBeGreaterThan(0);
  });

  it('warns instead of lying when the template cannot deliver the size', () => {
    // 90 % of the canvas is unreachable here: the hero zoom may not exceed nominal.
    const built = plan({ action_pose_left_hero: 0.9 });
    expect(built.warnings.some((entry) => entry.code === 'hero_fill_unmet')).toBe(true);
    expect(built.diagnostics.fills?.action_pose_left_hero.achieved).toBeLessThan(0.9);
  });
});

describe('parsing the size map out of the model answer', () => {
  const CANDIDATES = [
    { key: 'A', materialId: 'm-a' },
    { key: 'B', materialId: 'm-b' },
    { key: 'C', materialId: 'm-c' },
  ];
  const SLOTS = [{ slotId: 'rear_view_background' }];

  it('keeps only slots the template asked about', () => {
    const binding = parseBindingAnswer(
      {
        hero: 'A',
        package: 'B',
        package_found: true,
        slots: { rear_view_background: 'C' },
        size: { rear_view_background: 0.2, 我编的图位: 0.5, action_pose_left_hero: 0.4 },
      },
      CANDIDATES,
      SLOTS,
      'action_pose_left_hero',
    );
    expect(binding?.fills).toEqual({ rear_view_background: 0.2, action_pose_left_hero: 0.4 });
  });

  it('drops nonsense instead of drawing a 40× canvas', () => {
    const binding = parseBindingAnswer(
      { hero: 'A', size: { rear_view_background: 40, action_pose_left_hero: '0.3' } },
      CANDIDATES,
      SLOTS,
      'action_pose_left_hero',
    );
    // 40 is clamped to the ceiling; a string is not a number and is dropped.
    expect(binding?.fills).toEqual({ rear_view_background: 0.85 });
  });

  it('asks for sizes only when a collage slot is in play', () => {
    const slots = [{ slotId: 'rear_view_background' }];
    expect(buildBindingPrompt([{ key: 'A', label: '正面' }])).not.toContain('占画布面积');
    const withHero = buildBindingPrompt([{ key: 'A', label: '正面' }], slots, 'action_pose_left_hero');
    expect(withHero).toContain('占画布面积');
    expect(withHero).toContain('action_pose_left_hero');
    expect(withHero).toContain('"size"');
  });
});
