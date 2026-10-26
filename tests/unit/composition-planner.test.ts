import { describe, expect, it } from 'vitest';
import SOURCE from '../../src/services/composition/templates/hero_closeup_package_backdrop.v1.4.json';
import { opaqueProfile } from '../../src/services/composition/alpha';
import {
  contentRect,
  fromLayerPlacement,
  type ContentPlacement,
} from '../../src/services/composition/coverage';
import { parseLayoutTemplateOrThrow } from '../../src/services/composition/template-schema';
import { buildCompositionPlan, type PlannerMaterial } from '../../src/services/composition/planner';
import type { MeasureText } from '../../src/services/composition/text-fit';
import { planToLayers } from '../../src/editor/state/compose-emit';
import type { ImageLayer, TextLayer } from '../../src/shared/types';

const TEMPLATE = parseLayoutTemplateOrThrow(SOURCE);
const CLOSEUP = TEMPLATE.slots.find((slot) => slot.role === 'hero')!.closeup!;

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

const HERO = material('hero', 1000, 2000);
const BOX = material('box', 800, 1000);

describe('buildCompositionPlan — both materials present', () => {
  const plan = buildCompositionPlan({ template: TEMPLATE, hero: HERO, box: BOX, seed: 'MTS-0001' });

  it('places hero and box with the template z-order', () => {
    expect(plan.images).toHaveLength(2);
    expect(plan.images.map((image) => image.role)).toEqual(['box', 'hero']);
    expect(plan.images[0].zIndex).toBe(5);
    expect(plan.images[1].zIndex).toBe(10);
  });

  it('keeps the hero top edge pinned to the viewport top', () => {
    const hero = plan.images.find((image) => image.role === 'hero')!;
    const placement: ContentPlacement = fromLayerPlacement(HERO.profile, hero);
    const rect = contentRect(HERO.profile, placement);
    expect(rect[1]).toBeCloseTo(CLOSEUP.viewport[1], 6);
    expect((rect[0] + rect[2]) / 2).toBeCloseTo(CLOSEUP.centerX, 6);
  });

  it('reports what it did in diagnostics', () => {
    expect(plan.diagnostics.boxFallback).toBe('none');
    expect(plan.diagnostics.boxVariantIndex).not.toBeNull();
    expect(plan.diagnostics.heroNominalZoom).toBe(CLOSEUP.zoom);
    expect(plan.diagnostics.heroZoom).toBeLessThanOrEqual(CLOSEUP.zoom);
    expect(plan.diagnostics.heroOccupancy).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const again = buildCompositionPlan({ template: TEMPLATE, hero: HERO, box: BOX, seed: 'MTS-0001' });
    expect(again.diagnostics).toEqual(plan.diagnostics);
    expect(again.images.map((image) => image.x)).toEqual(plan.images.map((image) => image.x));
  });
});

describe('buildCompositionPlan — the box makes the hero give ground', () => {
  it('steps the zoom down until the box clears the visibility threshold', () => {
    // Raise the bar to 75% so the dominance solution (which leaves the box ~72%
    // visible) no longer passes and the second pass has to do something.
    const strict = structuredClone(SOURCE) as Record<string, any>;
    strict.rules.package_readability.min_visible_ratio = 0.75;
    const template = parseLayoutTemplateOrThrow(strict);

    const plan = buildCompositionPlan({ template, hero: HERO, box: BOX, seed: 'MTS-0001' });
    const relaxed = buildCompositionPlan({ template: TEMPLATE, hero: HERO, box: BOX, seed: 'MTS-0001' });

    expect(plan.diagnostics.heroZoom).toBeLessThan(relaxed.diagnostics.heroZoom);
    expect(plan.diagnostics.boxVisibleRatio).toBeGreaterThanOrEqual(0.75);
    expect(plan.warnings.map((entry) => entry.code)).toContain('hero_zoom_reduced');
    // Giving ground always costs dominance; the plan must say so, not hide it.
    expect(plan.diagnostics.heroOccupancy).toBeLessThan(relaxed.diagnostics.heroOccupancy);
  });

  it('admits when the box cannot be rescued', () => {
    // A 3:1 hero covers the box at every zoom >= 1, so no amount of shrinking saves it.
    const wide = material('wide', 3000, 1000);
    const plan = buildCompositionPlan({ template: TEMPLATE, hero: wide, box: BOX, seed: 'MTS-0001' });
    const codes = plan.warnings.map((entry) => entry.code);
    expect(codes).toContain('box_visibility_below_min');
    expect(plan.diagnostics.boxVisibleRatio).toBeLessThan(
      TEMPLATE.rules.packageReadability.minVisibleRatio,
    );
  });
});

describe('buildCompositionPlan — no package material', () => {
  it('falls back to another photo when the ladder offers it', () => {
    const secondary = material('side', 800, 1000);
    const plan = buildCompositionPlan({ template: TEMPLATE, hero: HERO, secondary, seed: 'MTS-0001' });
    expect(plan.images).toHaveLength(2);
    expect(plan.diagnostics.boxFallback).toBe('secondary_view');
    expect(plan.images[0].role).toBe('box');
    expect(plan.images[0].materialId).toBe(secondary.materialId);
    expect(plan.warnings.map((entry) => entry.code)).toContain('box_material_missing');
  });

  it('fills the empty slot with a plate', () => {
    const plan = buildCompositionPlan({ template: TEMPLATE, hero: HERO, seed: 'MTS-0001' });
    expect(plan.images).toHaveLength(1);
    expect(plan.diagnostics.boxFallback).toBe('plate');
    expect(plan.plates).toHaveLength(1);

    const plate = plan.plates[0];
    expect(plate.slotId).toBe('package_backdrop');
    expect(plate.zIndex).toBe(5);
    expect(plate.fill).toBe('#F5F5F5');
    expect(plate.cornerRadius).toBe(24);
    expect(plan.warnings.map((entry) => entry.code)).toContain('box_material_missing');
  });

  it('puts the model code on the plate rather than printing it twice', () => {
    const plan = buildCompositionPlan({
      template: TEMPLATE,
      hero: HERO,
      modelCode: 'A7-BOX-88',
      measure,
      seed: 'MTS-0001',
    });
    expect(plan.texts).toHaveLength(1);

    const caption = plan.texts[0];
    expect(caption.zoneId).toBe('package_backdrop:plate');
    expect(caption.align).toBe('center');
    // Above its own plate...
    expect(caption.zIndex).toBeGreaterThan(plan.plates[0].zIndex);
    // ...but still below the hero: a model number floating over the product would
    // read as a defect, not as a backdrop caption.
    expect(caption.zIndex).toBeLessThan(10);
    expect(caption.x).toBeCloseTo(plan.plates[0].x, 6);
    expect(caption.y).toBeCloseTo(plan.plates[0].y, 6);
    expect(plan.warnings.some((entry) => entry.message.includes('型号写在衬板上'))).toBe(true);
  });

  it('leaves the plate caption empty when there is no code', () => {
    const plan = buildCompositionPlan({ template: TEMPLATE, hero: HERO, seed: 'MTS-0001' });
    expect(plan.texts).toEqual([]);
  });

  it('slides the plate away from the hero instead of under it', () => {
    // The hero leans left (center_x 300). Variant 0 sits furthest left, so a plate
    // placed there would be mostly buried — and its caption with it.
    const wide = material('wide', 1400, 2000);
    const plan = buildCompositionPlan({ template: TEMPLATE, hero: wide, seed: 'MTS-0001' });
    const plate = plan.plates[0];
    expect(plate.x).toBeGreaterThanOrEqual(575);
    expect(plate.x).not.toBe(570);
  });
});

describe('buildCompositionPlan — model code text zone', () => {
  it('fits the code into the declared zone', () => {
    const plan = buildCompositionPlan({
      template: TEMPLATE,
      hero: HERO,
      box: BOX,
      modelCode: 'A7-BOX-88',
      measure,
      seed: 'MTS-0001',
    });
    expect(plan.texts).toHaveLength(1);
    const text = plan.texts[0];
    expect(text.zoneId).toBe('model_top_left');
    expect(text.text).toBe('A7-BOX-88');
    expect(text.fontSize).toBe(62);
    expect(text.align).toBe('left');
    expect(text.fontStyle).toBe('bold');
    expect(text.fontFamily).toBe('serif');
    // Flush with the zone's left edge under the centre-anchored layer model.
    expect(text.x - text.width / 2).toBeCloseTo(40, 6);
  });

  it('leaves the zone empty when there is no code', () => {
    const plan = buildCompositionPlan({ template: TEMPLATE, hero: HERO, box: BOX, seed: 'MTS-0001' });
    expect(plan.texts).toEqual([]);
  });

  it('still returns the text with a warning when it cannot fit', () => {
    const plan = buildCompositionPlan({
      template: TEMPLATE,
      hero: HERO,
      box: BOX,
      modelCode: 'X'.repeat(60),
      measure,
      seed: 'MTS-0001',
    });
    expect(plan.texts).toHaveLength(1);
    expect(plan.warnings.map((entry) => entry.code)).toContain('text_does_not_fit');
  });
});

describe('planToLayers', () => {
  const plan = buildCompositionPlan({
    template: TEMPLATE,
    hero: HERO,
    box: BOX,
    modelCode: 'A7-BOX-88',
    measure,
    seed: 'MTS-0001',
  });
  const layers = planToLayers(plan);

  it('emits one layer per planned item, bottom first', () => {
    expect(layers).toHaveLength(3);
    expect(layers.map((layer) => layer.kind)).toEqual(['cutout', 'cutout', 'text']);
  });

  it('puts the model code above both photographs', () => {
    const last = layers[layers.length - 1] as TextLayer;
    expect(last.kind).toBe('text');
    expect(layers.slice(0, 2).every((layer) => layer.kind !== 'text')).toBe(true);
  });

  it('carries the image payload and placement through unchanged', () => {
    const heroLayer = layers[1] as ImageLayer;
    const heroPlan = plan.images.find((image) => image.role === 'hero')!;
    expect(heroLayer.materialId).toBe(heroPlan.materialId);
    expect(heroLayer.blobId).toBe(heroPlan.blobId);
    expect(heroLayer.sourceWidth).toBe(1000);
    expect(heroLayer.sourceHeight).toBe(2000);
    expect(heroLayer.x).toBeCloseTo(heroPlan.x, 9);
    expect(heroLayer.scale).toBeCloseTo(heroPlan.scale, 9);
    expect(heroLayer.rotation).toBe(0);
    expect(heroLayer.flipX).toBe(false);
    expect(heroLayer.flipY).toBe(false);
  });

  it('emits text layers with outline and shadow switched off', () => {
    const text = layers[2] as TextLayer;
    expect(text.strokeWidth).toBe(0);
    expect(text.shadowBlur).toBe(0);
    expect(text.shadowOffsetX).toBe(0);
    expect(text.shadowOffsetY).toBe(0);
    expect(text.scale).toBe(1);
  });

  it('gives every layer a distinct id', () => {
    const ids = new Set(layers.map((layer) => layer.id));
    expect(ids.size).toBe(layers.length);
  });
});

describe('planToLayers — plate fallback', () => {
  const plan = buildCompositionPlan({
    template: TEMPLATE,
    hero: HERO,
    modelCode: 'A7-BOX-88',
    measure,
    seed: 'MTS-0001',
  });
  const layers = planToLayers(plan);

  it('emits plate, then its caption, then the hero', () => {
    // z: plate 5, caption 5.5, hero 10 — the caption belongs to the backdrop.
    expect(layers.map((layer) => layer.kind)).toEqual(['plate', 'text', 'cutout']);
  });

  it('emits the plate as a plain rect with the template fill', () => {
    const plate = layers[0];
    expect(plate.kind).toBe('plate');
    if (plate.kind !== 'plate') throw new Error('expected plate');
    expect(plate.fill).toBe('#F5F5F5');
    expect(plate.cornerRadius).toBe(24);
    expect(plate.width).toBeCloseTo(plan.plates[0].width, 6);
    expect(plate.height).toBeCloseTo(plan.plates[0].height, 6);
    expect(plate.x).toBeCloseTo(plan.plates[0].x, 6);
    expect(plate.scale).toBe(1);
  });
});
