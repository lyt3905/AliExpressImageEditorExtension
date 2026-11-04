import { describe, expect, it } from 'vitest';

import type { CompositionPlan } from '../../src/services/composition/planner';
import type { EditorLayer, ImageLayer } from '../../src/shared/types';
import { ONLY_KITS_FONT_RATIO, ONLY_KITS_TEXT } from '../../src/shared/constants';
import { carriedLayers } from '../../src/editor/state/compose-emit';

/** Only `texts` matters here; the rest of the plan is irrelevant to this seam. */
function planWith(texts: Array<{ text: string }>): CompositionPlan {
  return {
    texts: texts.map((text, index) => ({
      id: `planned-${index}`,
      text: text.text,
      x: 520,
      y: 180,
      width: 360,
      fontSize: 40,
      fontFamily: 'Arial',
      fill: '#123456',
      fontStyle: 'bold',
      align: 'center',
      scale: 1,
      rotation: 0,
      zIndex: 10 + index,
      stroke: '#ffffff',
      strokeWidth: 0,
      shadowColor: '#000000',
      shadowBlur: 0,
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      shadowOpacity: 0,
    })),
  } as unknown as CompositionPlan;
}

function imageLayer(id: string): ImageLayer {
  return {
    id,
    kind: 'cutout',
    materialId: `material-${id}`,
    blobId: id,
    sourceWidth: 400,
    sourceHeight: 400,
    x: 100,
    y: 100,
    scale: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
  };
}

function codeLayer(id: string, text: string): EditorLayer {
  return {
    id,
    kind: 'text',
    text,
    x: 400,
    y: 48,
    width: 200,
    fontSize: 24,
    fontFamily: 'sans-serif',
    fill: '#000000',
    fontStyle: 'normal',
    align: 'center',
    scale: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
    stroke: '#ffffff',
    strokeWidth: 0,
    shadowColor: '#000000',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowOpacity: 0,
  };
}

function brandLayer(id: string): EditorLayer {
  return { ...imageLayer(id), kind: 'brand', locked: true };
}

describe('carriedLayers', () => {
  it('keeps brand logos and drops everything the plan replaces', () => {
    const existing = [imageLayer('a'), brandLayer('logo'), imageLayer('b')];
    expect(carriedLayers(planWith([]), existing, null)).toEqual([brandLayer('logo')]);
  });

  it('carries the code text when the template has no text zone for it', () => {
    // The collage template has `text_zones: []`, so the plan carries no code.
    const existing = [codeLayer('code', 'MTS-TF-0001'), brandLayer('logo')];
    expect(carriedLayers(planWith([]), existing, 'MTS-TF-0001')).toEqual([
      codeLayer('code', 'MTS-TF-0001'),
      brandLayer('logo'),
    ]);
  });

  it('does not duplicate the code when the plan already places it', () => {
    // 「主图 + 包装盒」has a text zone: position comes from the template.
    const existing = [codeLayer('code', 'MTS-TF-0001')];
    expect(carriedLayers(planWith([{ text: 'MTS-TF-0001' }]), existing, 'MTS-TF-0001')).toEqual([]);
  });

  it('matches the code by trimmed text, like the hydrate path does', () => {
    const existing = [codeLayer('code', '  MTS-TF-0001  ')];
    expect(carriedLayers(planWith([{ text: 'MTS-TF-0001' }]), existing, ' MTS-TF-0001 ')).toEqual([]);
  });

  it('carries other text layers never, even when the code is missing', () => {
    const existing = [codeLayer('other', '新品'), codeLayer('code', 'MTS-TF-0001')];
    expect(carriedLayers(planWith([]), existing, 'ABC-123')).toEqual([]);
  });

  it('treats an empty product code as "no code to carry"', () => {
    const existing = [codeLayer('code', ''), brandLayer('logo')];
    expect(carriedLayers(planWith([]), existing, '')).toEqual([brandLayer('logo')]);
  });
});

describe('carriedLayers — the 「Only Kits」 label', () => {
  it('keeps an existing Only Kits layer when the plan does not place it', () => {
    // Collage template: no text zone, so 自动排版 must not swallow the label the
    // editor created from the title.
    const existing = [codeLayer('kits', ONLY_KITS_TEXT), brandLayer('logo')];
    expect(carriedLayers(planWith([]), existing, null)).toEqual([
      codeLayer('kits', ONLY_KITS_TEXT),
      brandLayer('logo'),
    ]);
  });

  it('keeps Only Kits when the title had no product code at all', () => {
    // The common kit listing: no `xxx-xxx` code, label only.
    const existing = [codeLayer('kits', ONLY_KITS_TEXT)];
    expect(carriedLayers(planWith([]), existing, undefined)).toEqual([codeLayer('kits', ONLY_KITS_TEXT)]);
  });

  it('does not duplicate Only Kits when the plan already places it', () => {
    const existing = [codeLayer('kits', ONLY_KITS_TEXT)];
    expect(carriedLayers(planWith([{ text: ONLY_KITS_TEXT }]), existing, null)).toEqual([]);
  });

  it('realigns Only Kits below the new code produced by a composition plan', () => {
    const code = 'MTS-TF-0001';
    const existing = [codeLayer('kits', ONLY_KITS_TEXT)];
    const carried = carriedLayers(planWith([{ text: code }]), existing, code);
    const kits = carried[0];

    expect(kits?.kind).toBe('text');
    if (kits?.kind !== 'text') throw new Error('expected a text layer');
    expect(kits.id).toBe('kits');
    expect(kits.x).toBe(520);
    expect(kits.width).toBe(360);
    // The label is sized down from the code instead of inheriting it (see
    // `fitOnlyKitsFontSize`): 40 -> 62% -> 25, one line inside 360px.
    expect(kits.fontSize).toBe(Math.round(40 * ONLY_KITS_FONT_RATIO));
    expect(kits.fill).toBe('#123456');
    expect(kits.y).toBeGreaterThan(180 + 40 / 2);
  });

  it('matches Only Kits by trimmed text', () => {
    const existing = [codeLayer('kits', `  ${ONLY_KITS_TEXT}  `)];
    expect(carriedLayers(planWith([{ text: ONLY_KITS_TEXT }]), existing, null)).toEqual([]);
  });

  it('carries code, then Only Kits, then brand logos', () => {
    // Paint order: the carried code was the top-most text before this feature, so
    // the label slots in directly under it and both stay under the logos.
    const existing = [
      imageLayer('a'),
      codeLayer('kits', ONLY_KITS_TEXT),
      codeLayer('code', 'MTS-TF-0001'),
      brandLayer('logo'),
    ];
    expect(carriedLayers(planWith([]), existing, 'MTS-TF-0001')).toEqual([
      codeLayer('code', 'MTS-TF-0001'),
      codeLayer('kits', ONLY_KITS_TEXT),
      brandLayer('logo'),
    ]);
  });

  it('still carries only the label — no other text layer rides along', () => {
    const existing = [codeLayer('other', '新品'), codeLayer('kits', ONLY_KITS_TEXT)];
    expect(carriedLayers(planWith([]), existing, null)).toEqual([codeLayer('kits', ONLY_KITS_TEXT)]);
  });
});
