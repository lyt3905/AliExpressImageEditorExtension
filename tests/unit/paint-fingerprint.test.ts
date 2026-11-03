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
import { brandPaintIdentity, paintFingerprintOf, paintParts } from '../../src/editor/state/paint-fingerprint';

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

  it('still tells two materials apart when the identity map knows neither', () => {
    /*
      复核 R6 的第二个反例：品牌 Logo 与原图都不在 `identityByMaterialId` 里，
      旧实现把它们都归成空字符串 —— 两个不同 Logo、尺寸位置一样，键就撞了，
      "下载缓存成品"会把上一个 Logo 的成品给出来。
    */
    const logoA: ImageLayer = picture('logo', {
      kind: 'brand',
      materialId: 'material-brand-a',
      blobId: 'brand-logo-a',
    });
    const logoB: ImageLayer = picture('logo', {
      kind: 'brand',
      materialId: 'material-brand-b',
      blobId: 'brand-logo-b',
    });
    const empty = new Map<string, string>();
    expect(paintParts([logoB], empty, null)).not.toEqual(paintParts([logoA], empty, null));

    const originalA: ImageLayer = picture('original', {
      kind: 'original',
      materialId: 'material-original-1',
      blobId: 'session-1-image',
    });
    const originalB: ImageLayer = picture('original', {
      kind: 'original',
      materialId: 'material-original-2',
      blobId: 'session-2-image',
    });
    expect(paintParts([originalB], empty, null)).not.toEqual(paintParts([originalA], empty, null));
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

  it('tells the same brand Logo apart after its content is updated', () => {
    /*
      三次复核 R6：目录同步用**同一个 blob id 覆盖内容**，v1 → v2 的 Logo 内容摘要不同
      （1068f7af… → 49f2e0c3…）但 blobId 一样，旧键 `brand:<id>:<blobId>` 两次都是
      `fae2680b` → "下载缓存成品"给出上一版 Logo。身份必须带上内容版本 `remoteRev`。
    */
    const blobId = 'brand-logo-remote-test-brand';
    const v1 = brandPaintIdentity('material-brand-test-brand', 'v1', blobId);
    const v2 = brandPaintIdentity('material-brand-test-brand', 'v2', blobId);
    expect(v2).not.toBe(v1);
    // 同一个版本重复同步（内容没变）必须还是同一个身份，否则每同步一次就白丢一份缓存。
    expect(brandPaintIdentity('material-brand-test-brand', 'v1', blobId)).toBe(v1);
    // 换品牌、换 blob 也一样要区分。
    expect(brandPaintIdentity('material-brand-other', 'v1', blobId)).not.toBe(v1);
    expect(brandPaintIdentity('material-brand-test-brand', 'v1', 'brand-logo-x')).not.toBe(v1);
  });
});
