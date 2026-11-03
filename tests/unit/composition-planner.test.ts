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
import type { Rect } from '../../src/services/composition/types';
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
  it('leaves the box alone when the hero never reaches it', () => {
    /*
      遮挡率按"两块 alpha 真的相交"算（复核 R3）。这张模板把包装盒放在主体够不到的右下区，
      但 hero 在 zoom≈1.816 下仍会压到盒子的一角 —— 真实相交约 27%，可见率 ≈0.73，高于
      可读性地板 0.65，所以主体不该白白让位。
      10.22.4 之前这条能用 `toBe(1)` 通过，是因为采样只查了盒子中心一格：那是同一个 bug
      的另一面（粗网格漏算），不是"没压到"。
    */
    const relaxed = buildCompositionPlan({ template: TEMPLATE, hero: HERO, box: BOX, seed: 'MTS-0001' });
    expect(relaxed.diagnostics.boxVisibleRatio).toBeGreaterThan(
      TEMPLATE.rules.packageReadability.minVisibleRatio,
    );
    expect(relaxed.warnings.map((entry) => entry.code)).not.toContain('box_visibility_below_min');
    // 主体缩放被包装盒逼着退让，才是判据偏了：和不带盒子的计划比，heroZoom 必须一样。
    // （1.816 而不是模板名义值 2.2，是因为 hero_dominance 的占用率上限先把它压下来了。）
    const alone = buildCompositionPlan({ template: TEMPLATE, hero: HERO, seed: 'MTS-0001' });
    expect(relaxed.diagnostics.heroZoom).toBeCloseTo(alone.diagnostics.heroZoom, 6);
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

/*
  10.22.1（审查 P2-7）：`reserved_zones` 里写着「hero 不许进底栏」，可校验期只能看
  `closeup.viewport`；放大之后的 alpha 完全可能越过那条底边（审查复现：1000×2000 的
  主体在 zoom 1.816 下底边到 1142）。所以运行期还要按最终 alpha 复查一次。
*/
describe('reserved zones are checked after the layout settles', () => {
  const footer: Rect = [0, 712, 800, 800];

  it('reports a picture whose alpha reaches into a zone it was told to avoid', () => {
    // The shipped template lets the hero overflow its viewport (hero_dominance zooms it
    // 1.82×) and only keeps the *box* out of the store strip — but if a template does
    // list a role here, the finished layout has to be checked against its real alpha,
    // not just against `closeup.viewport` (10.22.1, review P2-7).
    const template = {
      ...TEMPLATE,
      canvas: {
        ...TEMPLATE.canvas,
        reservedZones: [{ id: 'store_footer', box: footer, avoidFor: ['hero' as const] }],
      },
    };
    const plan = buildCompositionPlan({ template, hero: HERO, seed: 'MTS-0001' });
    const overlap = plan.warnings.find((entry) => entry.code === 'reserved_zone_overlap');
    expect(overlap).toBeDefined();
    expect(overlap!.detail).toMatchObject({ zoneId: 'store_footer', slotId: 'hero_closeup' });
    expect(Number(overlap!.detail!.covered)).toBeGreaterThan(0.02);
  });

  it('stays quiet when the shipped template only keeps the box out of the strip', () => {
    const plan = buildCompositionPlan({ template: TEMPLATE, hero: HERO, seed: 'MTS-0001' });
    expect(plan.warnings.map((entry) => entry.code)).not.toContain('reserved_zone_overlap');
  });
});
