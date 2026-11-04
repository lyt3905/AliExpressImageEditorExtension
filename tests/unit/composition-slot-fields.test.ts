/**
 * M2 模板字段：`purpose` / `fit` / `allow_source_reuse` / `effects`。
 *
 * 这一组用例守的是"配置写了就必须真的生效"：解析期不许静默忽略拼错的键，排版期
 * 装饰背景不许被当成商品算（去重、张数底线、观感数字），落成图层时必须把效果带上，
 * 否则模板里的描边只是 JSON 里的一行字。
 */

import { describe, expect, it } from 'vitest';
import POSTER_SOURCE from '../../src/services/composition/templates/dramatic_glow_character_poster.v1.0.json';
import COLLAGE_SOURCE from '../../src/services/composition/templates/three_pose_figure_collage_white.v1.0.json';
import { opaqueProfile } from '../../src/services/composition/alpha';
import { contentRect, fromLayerPlacement } from '../../src/services/composition/coverage';
import { buildCompositionPlan, type PlannerMaterial } from '../../src/services/composition/planner';
import { parseLayoutTemplate, parseLayoutTemplateOrThrow } from '../../src/services/composition/template-schema';
import { DEFAULT_IMAGE_EFFECTS } from '../../src/shared/constants';
import { planToLayers } from '../../src/editor/state/compose-emit';
import type { ImageLayer } from '../../src/shared/types';

type Raw = Record<string, any>;
function posterRaw(): Raw {
  return structuredClone(POSTER_SOURCE) as unknown as Raw;
}

function issuesOf(result: { issues: Array<{ path: string; message: string }> }): string {
  return result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}

const POSTER = parseLayoutTemplateOrThrow(POSTER_SOURCE);
const COLLAGE = parseLayoutTemplateOrThrow(COLLAGE_SOURCE);

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
const BACKDROP = material('backdrop', 900, 900);
const DETAIL = material('detail', 1200, 800);

describe('slot fields — parsing', () => {
  it('accepts the shipped poster template with no issues', () => {
    const result = parseLayoutTemplate(POSTER_SOURCE);
    expect(issuesOf(result)).toBe('');
    expect(result.template).not.toBeNull();
  });

  it('reads purpose / fit / allow_source_reuse off the backdrop slot', () => {
    const backdrop = POSTER.slots.find((slot) => slot.id === 'backdrop')!;
    expect(backdrop.purpose).toBe('decorative_background');
    expect(backdrop.materialFit).toBe('cover');
    expect(backdrop.allowSourceReuse).toBe(true);
  });

  it('normalises snake_case effect keys and keeps the authored numbers', () => {
    const hero = POSTER.slots.find((slot) => slot.role === 'hero')!;
    expect(hero.effects?.outlineColor).toBe('#ff2638');
    expect(hero.effects?.outlineWidth).toBe(4);
    expect(hero.effects?.outlineGlow).toBe(14);
    expect(hero.effects?.outlineOpacity).toBeCloseTo(0.75, 6);
    // 没写的字段落在默认值上，而不是 undefined —— 图层拿到的永远是一份完整效果。
    expect(hero.effects?.opacity).toBe(DEFAULT_IMAGE_EFFECTS.opacity);
    expect(hero.effects?.grayscale).toBe(false);

    const backdrop = POSTER.slots.find((slot) => slot.id === 'backdrop')!;
    expect(backdrop.effects?.grayscale).toBe(true);
    expect(backdrop.effects?.brightness).toBeCloseTo(-0.34, 6);
    expect(backdrop.effects?.opacity).toBeCloseTo(0.62, 6);
    expect(backdrop.effects?.outlineWidth).toBe(0);
  });

  it('leaves the four fields undefined on templates that never mention them', () => {
    for (const slot of COLLAGE.slots) {
      expect(slot.purpose).toBeUndefined();
      expect(slot.materialFit).toBeUndefined();
      expect(slot.allowSourceReuse).toBeUndefined();
      expect(slot.effects).toBeUndefined();
    }
  });

  it('rejects an unknown purpose instead of ignoring it', () => {
    const raw = posterRaw();
    raw.slots[0].purpose = 'background';
    const result = parseLayoutTemplate(raw);
    expect(result.issues.map((issue) => issue.path)).toContain('slots[0].purpose');
    expect(issuesOf(result)).toContain('未知用途 background');
  });

  it('rejects an unknown fit instead of ignoring it', () => {
    const raw = posterRaw();
    raw.slots[0].fit = 'fill';
    const result = parseLayoutTemplate(raw);
    expect(result.issues.map((issue) => issue.path)).toContain('slots[0].fit');
    expect(issuesOf(result)).toContain('未知的填充方式 fill');
  });

  it('rejects a misspelled effect key — silent drops look like the field is ignored', () => {
    const raw = posterRaw();
    raw.slots[2].effects = { outline_widht: 6 };
    const result = parseLayoutTemplate(raw);
    expect(result.issues.map((issue) => issue.path)).toContain('slots[2].effects.outline_widht');
  });

  it('drops an effect block that normalises to「什么都没开」', () => {
    const raw = posterRaw();
    raw.slots[2].effects = { opacity: 1, grayscale: false };
    const template = parseLayoutTemplate(raw).template!;
    expect(template.slots.find((slot) => slot.role === 'hero')!.effects).toBeUndefined();
  });

  it('defaults a template that never declares canvas.background to white', () => {
    const raw = posterRaw();
    delete raw.canvas.background;
    const result = parseLayoutTemplate(raw);
    expect(issuesOf(result)).toBe('');
    expect(result.template!.canvas.background).toBe('#ffffff');
  });
});

describe('slot fields — planner', () => {
  const plan = buildCompositionPlan({
    template: POSTER,
    hero: HERO,
    seed: 'MTS-0001',
    supports: [
      { slotId: 'backdrop', material: BACKDROP },
      { slotId: 'detail_inset', material: DETAIL },
    ],
  });

  it('emits the backdrop as a decorative picture that carries its own effects', () => {
    const backdrop = plan.images.find((image) => image.slotId === 'backdrop')!;
    expect(backdrop.decorative).toBe(true);
    expect(backdrop.effects?.grayscale).toBe(true);
  });

  it('covers the whole canvas with `fit: cover` instead of fitting inside it', () => {
    const backdrop = plan.images.find((image) => image.slotId === 'backdrop')!;
    // `Rect` 是 [left, top, right, bottom]。
    const rect = contentRect(BACKDROP.profile, fromLayerPlacement(BACKDROP.profile, backdrop));
    expect(rect[0]).toBeLessThanOrEqual(0.01);
    expect(rect[1]).toBeLessThanOrEqual(0.01);
    expect(rect[2]).toBeGreaterThanOrEqual(800 - 0.01);
    expect(rect[3]).toBeGreaterThanOrEqual(800 - 0.01);
  });

  it('keeps `fit: contain` for the detail inset', () => {
    const detail = plan.images.find((image) => image.slotId === 'detail_inset')!;
    const rect = contentRect(DETAIL.profile, fromLayerPlacement(DETAIL.profile, detail));
    // 视口是 286×240：装下的语义是"不超出这个框"。
    expect(rect[2] - rect[0]).toBeLessThanOrEqual(286 + 0.01);
    expect(rect[3] - rect[1]).toBeLessThanOrEqual(240 + 0.01);
    expect(detail.effects).toBeUndefined();
  });

  it('lets the backdrop reuse the hero source when allow_source_reuse is on', () => {
    const reused = buildCompositionPlan({
      template: POSTER,
      hero: HERO,
      seed: 'MTS-0001',
      supports: [{ slotId: 'backdrop', material: HERO }],
    });
    expect(reused.images.map((image) => image.slotId)).toContain('backdrop');
    expect(reused.warnings.map((item) => item.code)).not.toContain('support_slot_empty');
  });

  it('keeps「同一张图不许占两个槽位」for templates that did not opt in', () => {
    const duplicate = buildCompositionPlan({
      template: COLLAGE,
      hero: HERO,
      seed: 'MTS-0001',
      supports: [{ slotId: 'rear_view_background', material: HERO }],
    });
    expect(duplicate.images.map((image) => image.slotId)).not.toContain('rear_view_background');
    expect(duplicate.warnings.map((item) => item.code)).toContain('support_slot_empty');
  });

  it('does not let the decorative backdrop satisfy rules.collage.min_pictures', () => {
    const raw = posterRaw();
    raw.rules.collage.min_pictures = 2;
    const strict = parseLayoutTemplateOrThrow(raw);
    const onlyBackdrop = buildCompositionPlan({
      template: strict,
      hero: HERO,
      seed: 'MTS-0001',
      supports: [{ slotId: 'backdrop', material: BACKDROP }],
    });
    // 只剩主体一个"商品"：装饰背景不算第二张，模板的底线因此不成立。
    expect(onlyBackdrop.images).toHaveLength(0);
    expect(onlyBackdrop.warnings.map((item) => item.code)).toContain('not_enough_pictures');
  });
});

describe('slot fields — emit', () => {
  it('writes the template effects onto the image layer', () => {
    const plan = buildCompositionPlan({
      template: POSTER,
      hero: HERO,
      seed: 'MTS-0001',
      supports: [{ slotId: 'detail_inset', material: DETAIL }],
    });
    const layers = planToLayers(plan) as ImageLayer[];
    const heroLayer = layers.find((layer) => layer.materialId === HERO.materialId)!;
    expect(heroLayer.effects?.outlineWidth).toBe(4);
    expect(heroLayer.effects?.outlineColor).toBe('#ff2638');
  });
});
