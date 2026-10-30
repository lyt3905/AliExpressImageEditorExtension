import { describe, expect, it } from 'vitest';

import type { CompositionPlan } from '../../src/services/composition/planner';
import type { EditorLayer, ImageLayer } from '../../src/shared/types';
import { carriedLayers } from '../../src/editor/state/compose-emit';

/** Only `texts` matters here; the rest of the plan is irrelevant to this seam. */
function planWith(texts: Array<{ text: string }>): CompositionPlan {
  return { texts } as unknown as CompositionPlan;
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
