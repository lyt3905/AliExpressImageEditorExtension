/**
 * 成品图缓存键必须跟着画布走。
 *
 * 2026-11-03 的复核用三个反例说明 10.22.1 的"按排版计划算键"漏了什么：把不透明度从 1
 * 改成 0、加一圈红色发光、把 hero 从 x=400/scale=1 挪到 x=600/scale=2 —— 键一个字都没变，
 * 于是「下载缓存成品」给出的还是上一版。这些用例锁住"改了就必须换键"。
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_EFFECTS } from '../../src/shared/constants';
import type {
  EditorLayer,
  ImageEffects,
  ImageLayer,
  PlateLayer,
  TextLayer,
  WatermarkLayer,
} from '../../src/shared/types';
import { paintFingerprintOf, paintParts } from '../../src/editor/state/paint-fingerprint';

const IDENTITIES = new Map<string, string>([['material-hero', 'url:https://cdn/a.jpg']]);

function picture(id: string, patch: Partial<ImageLayer> = {}): ImageLayer {
  return {
    id,
    kind: 'cutout',
    x: 400,
    y: 400,
    rotation: 0,
    scale: 1,
    materialId: 'material-hero',
    blobId: 'blob-hero',
    sourceWidth: 1000,
    sourceHeight: 2000,
    ...patch,
  };
}

function withEffects(patch: Partial<ImageEffects>): ImageLayer {
  return picture('pic', { effects: { ...DEFAULT_IMAGE_EFFECTS, ...patch } });
}

function text(text = 'MTS-0001'): TextLayer {
  return {
    id: 'code',
    kind: 'text',
    x: 400,
    y: 48,
    rotation: 0,
    scale: 1,
    text,
    width: 400,
    fontSize: 42,
    fontFamily: 'Arial',
    fill: '#000000',
    fontStyle: 'bold',
    align: 'center',
    stroke: '#000000',
    strokeWidth: 0,
    shadowColor: '#000000',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    shadowOpacity: 0,
  };
}

function plate(): PlateLayer {
  return {
    id: 'plate',
    kind: 'plate',
    x: 600,
    y: 400,
    rotation: 0,
    scale: 1,
    width: 200,
    height: 300,
    fill: '#f7f9fc',
    cornerRadius: 12,
  };
}

function fingerprint(layers: readonly EditorLayer[], watermark: WatermarkLayer | null = null): string[] {
  const parts = paintFingerprintOf(layers, IDENTITIES, watermark);
  expect(parts).not.toBeNull();
  return parts as string[];
}

describe('paintFingerprintOf', () => {
  it('changes when the opacity changes', () => {
    const before = fingerprint([withEffects({ opacity: 1 })]);
    const after = fingerprint([withEffects({ opacity: 0 })]);
    expect(after).not.toEqual(before);
  });

  it('changes when a glow is added', () => {
    const before = fingerprint([withEffects({})]);
    const after = fingerprint([
      withEffects({ glowOpacity: 0.6, glowRadius: 6, glowBlur: 24, glowColor: '#ff0000' }),
    ]);
    expect(after).not.toEqual(before);
  });

  it('changes when the picture is moved, scaled or restacked', () => {
    const before = fingerprint([picture('pic')]);
    expect(fingerprint([picture('pic', { x: 600 })])).not.toEqual(before);
    expect(fingerprint([picture('pic', { scale: 2 })])).not.toEqual(before);
    expect(fingerprint([picture('pic', { rotation: 45 })])).not.toEqual(before);
    expect(fingerprint([picture('pic', { flipX: true })])).not.toEqual(before);
    const restacked = fingerprint([picture('pic'), plate()]);
    expect(fingerprint([plate(), picture('pic')])).not.toEqual(restacked);
  });

  it('changes when the identity of the picture changes', () => {
    const before = paintParts([picture('pic')], IDENTITIES, null);
    const other = new Map([['material-hero', 'url:https://cdn/b.jpg']]);
    expect(paintParts([picture('pic')], other, null)).not.toEqual(before);
  });

  it('tracks the watermark and the code text', () => {
    const watermark = {
      id: 'watermark',
      kind: 'watermark' as const,
      x: 400,
      y: 700,
      rotation: 0,
      scale: 0.2,
      materialId: 'material-watermark',
      blobId: 'blob-wm',
      sourceWidth: 800,
      sourceHeight: 400,
    };
    const plain = fingerprint([picture('pic')]);
    expect(fingerprint([picture('pic')], watermark)).not.toEqual(plain);
    const moved = fingerprint([picture('pic')], { ...watermark, y: 600 });
    expect(moved).not.toEqual(fingerprint([picture('pic')], watermark));
    expect(fingerprint([picture('pic'), text('A')])).not.toEqual(
      fingerprint([picture('pic'), text('B')]),
    );
  });

  it('returns null when nothing but text and plates is painted', () => {
    expect(paintFingerprintOf([text(), plate()], IDENTITIES, null)).toBeNull();
  });
});
