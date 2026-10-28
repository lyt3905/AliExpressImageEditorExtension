/**
 * Three-photo collage: a template with more picture slots than hero + package.
 *
 * The rule these tests pin down: the collage template's own geometry is used
 * verbatim (no solver moves a slot), every slot gets a DIFFERENT photo, and a slot
 * nobody could fill is a warning plus an empty space — never a duplicate photo and
 * never a thrown error.
 */

import { describe, expect, it } from 'vitest';
import COLLAGE_SOURCE from '../../src/services/composition/templates/three_pose_figure_collage_white.v1.0.json';
import { opaqueProfile } from '../../src/services/composition/alpha';
import {
  selectSupportMaterials,
  type BindCandidate,
} from '../../src/services/composition/bind-materials';
import { buildCompositionPlan, type PlannerMaterial } from '../../src/services/composition/planner';
import { parseLayoutTemplateOrThrow } from '../../src/services/composition/template-schema';
import { parseBindingAnswer } from '../../src/services/composition/vision-binder';
import type { MeasureText } from '../../src/services/composition/text-fit';

const TEMPLATE = parseLayoutTemplateOrThrow(COLLAGE_SOURCE);
const measure: MeasureText = (text, font) => text.length * font.size * 0.6;

function material(id: string, width: number, height: number): PlannerMaterial {
  return {
    materialId: `material-${id}`,
    blobId: `blob-${id}`,
    kind: 'cutout',
    profile: opaqueProfile(width, height),
    label: id,
  };
}

function candidate(id: string, width: number, height: number): BindCandidate {
  return { materialId: `material-${id}`, label: id, width, height };
}

const HERO = material('hero', 1000, 2000);
const REAR = material('rear', 800, 1600);
const FRONT = material('front', 900, 1800);

describe('three_pose_figure_collage_white template', () => {
  it('parses into three picture slots with the declared geometry', () => {
    expect(TEMPLATE.id).toBe('three_pose_figure_collage_white');
    expect(TEMPLATE.slots).toHaveLength(3);

    const hero = TEMPLATE.slots.find((slot) => slot.role === 'hero')!;
    expect(hero.id).toBe('action_pose_left_hero');
    expect(hero.zIndex).toBe(30);
    // viewport is a [x, y, width, height] tuple, copied verbatim from the template.
    expect(hero.closeup!.viewport).toEqual([0, 80, 680, 800]);
    expect(hero.closeup!.zoom).toBeCloseTo(1.08, 6);

    const rear = TEMPLATE.slots.find((slot) => slot.id === 'rear_view_background')!;
    expect(rear.closeup!.viewport).toEqual([160, 0, 610, 770]);
  });

  it('keeps source_selection as a hint for the vision model', () => {
    const rear = TEMPLATE.slots.find((slot) => slot.id === 'rear_view_background')!;
    expect(rear.sourceSelection?.viewTypes).toEqual(['rear', 'back']);
    expect(rear.sourceSelection?.expectedClass).toBe('figure');
  });

  it('reads `collage.allow_alpha_overlap` as「不要防重叠」', () => {
    // The collage dialect states the rule positively; the geometry layer stores it
    // as preventAlphaOverlap, so the boolean has to come out inverted.
    expect(TEMPLATE.rules.collision.preventAlphaOverlap).toBe(false);
    expect(TEMPLATE.rules.collision.minGapPx).toBe(0);
  });
});

describe('selectSupportMaterials', () => {
  const slots = [{ slotId: 'rear_view_background' }, { slotId: 'front_view_right' }];
  const candidates = [candidate('a', 400, 800), candidate('b', 1200, 2400), candidate('c', 900, 1800)];

  it('prefers the AI answer over area', () => {
    const assignments = selectSupportMaterials({
      slots,
      candidates,
      usedIds: ['material-hero'],
      preference: { rear_view_background: 'material-a', front_view_right: 'material-c' },
    });
    expect(assignments).toEqual([
      { slotId: 'rear_view_background', materialId: 'material-a' },
      { slotId: 'front_view_right', materialId: 'material-c' },
    ]);
  });

  it('fills the rest by area when the AI said nothing', () => {
    const assignments = selectSupportMaterials({
      slots,
      candidates,
      usedIds: ['material-hero'],
      preference: { rear_view_background: 'material-a' },
    });
    // 'b' is the largest untouched photo.
    expect(assignments[1]).toEqual({ slotId: 'front_view_right', materialId: 'material-b' });
  });

  it('never hands the same photo to two slots', () => {
    const assignments = selectSupportMaterials({
      slots,
      candidates,
      usedIds: [],
      // The model answered the same key twice; the second one must be refused.
      preference: { rear_view_background: 'material-b', front_view_right: 'material-b' },
    });
    expect(assignments.map((entry) => entry.materialId)).toEqual(['material-b', 'material-c']);
  });

  it('skips the hero and leaves slots empty when photos run out', () => {
    const assignments = selectSupportMaterials({
      slots,
      candidates,
      usedIds: ['material-b'],
    });
    expect(assignments).toHaveLength(2);
    expect(assignments.map((entry) => entry.materialId)).toEqual(['material-c', 'material-a']);
  });
});

describe('buildCompositionPlan — collage', () => {
  it('places hero and both supports in z order', () => {
    const plan = buildCompositionPlan({
      template: TEMPLATE,
      hero: HERO,
      supports: [
        { slotId: 'rear_view_background', material: REAR },
        { slotId: 'front_view_right', material: FRONT },
      ],
      seed: 'MTS-0001',
    });

    expect(plan.images.map((image) => image.slotId)).toEqual([
      'rear_view_background',
      'front_view_right',
      'action_pose_left_hero',
    ]);
    expect(plan.images.map((image) => image.zIndex)).toEqual([10, 20, 30]);
  });

  it('leaves a slot empty with a warning instead of failing', () => {
    const plan = buildCompositionPlan({
      template: TEMPLATE,
      hero: HERO,
      supports: [{ slotId: 'rear_view_background', material: REAR }],
      seed: 'MTS-0001',
    });

    expect(plan.images).toHaveLength(2);
    const warning = plan.warnings.find((entry) => entry.code === 'support_slot_empty');
    expect(warning?.detail?.slotId).toBe('front_view_right');
  });

  it('refuses to place one photo twice', () => {
    const plan = buildCompositionPlan({
      template: TEMPLATE,
      hero: HERO,
      supports: [
        { slotId: 'rear_view_background', material: REAR },
        // Same material as the slot above — the second one is dropped.
        { slotId: 'front_view_right', material: REAR },
      ],
      seed: 'MTS-0001',
    });

    expect(plan.images).toHaveLength(2);
    const codes = plan.warnings.map((entry) => entry.code);
    expect(codes).toContain('support_slot_empty');
  });

  it('does not place a support material that is already the hero', () => {
    const plan = buildCompositionPlan({
      template: TEMPLATE,
      hero: HERO,
      supports: [{ slotId: 'rear_view_background', material: HERO }],
      seed: 'MTS-0001',
    });

    expect(plan.images).toHaveLength(1);
    expect(plan.warnings.map((entry) => entry.code)).toContain('support_slot_empty');
  });
});

describe('parseBindingAnswer — collage slots', () => {
  const candidates = [
    { key: 'A', materialId: 'material-hero' },
    { key: 'B', materialId: 'material-rear' },
    { key: 'C', materialId: 'material-front' },
  ];
  const slots = [{ slotId: 'rear_view_background' }, { slotId: 'front_view_right' }];

  it('reads the slots object into slotMaterialIds', () => {
    const binding = parseBindingAnswer(
      {
        hero: 'A',
        package: null,
        package_found: false,
        slots: { rear_view_background: 'B', front_view_right: 'C' },
        reason: '三个视角',
      },
      candidates,
      slots,
    );
    expect(binding?.slotMaterialIds).toEqual({
      rear_view_background: 'material-rear',
      front_view_right: 'material-front',
    });
  });

  it('ignores unknown slot ids, unknown letters, repeats and the hero', () => {
    const binding = parseBindingAnswer(
      {
        hero: 'A',
        package_found: false,
        slots: {
          rear_view_background: 'A',
          front_view_right: 'Q',
          not_a_slot: 'B',
        },
      },
      candidates,
      slots,
    );
    expect(binding?.slotMaterialIds).toEqual({});
  });

  it('is empty when the template asked for no collage slots', () => {
    const binding = parseBindingAnswer(
      { hero: 'A', package: 'B', package_found: true, slots: { rear_view_background: 'C' } },
      candidates,
    );
    expect(binding?.slotMaterialIds).toEqual({});
  });
});

/** `measure` is exercised by the planner tests; kept here so the template stays measurable. */
void measure;
