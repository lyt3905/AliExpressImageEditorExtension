import { describe, expect, it } from 'vitest';
import { computeOutlinePixels, outlineSpecOf, type OutlineSpec } from '../../src/services/alpha-outline';
import { DEFAULT_IMAGE_EFFECTS } from '../../src/shared/constants';

/**
 * 描边是**像素级**效果，所以断言也必须在像素上做（10.23.0）。
 *
 * 只测"参数被接受 / 归一化"证明不了渲染正确：真正要回答的是"这一圈红色到底落在
 * 剪影里面还是外面""主体自己有没有被染红""外晕是不是随距离衰减"。这里用
 * `computeOutlinePixels()`（无 DOM 的纯光栅器）在 Node 里直接验这三件事。
 */

const SPEC: OutlineSpec = { width: 3, glow: 4, color: '#ff2638', opacity: 1 };
const SIZE = 40;
const PAD = Math.ceil(SPEC.width + SPEC.glow) + 2; // 9

/** 40×40 里一块 [10, 29] 的实心方块，其余透明。 */
function squareAlpha(size = SIZE, from = 10, to = 29): Uint8ClampedArray {
  const alpha = new Uint8ClampedArray(size * size);
  for (let y = from; y <= to; y += 1) {
    for (let x = from; x <= to; x += 1) alpha[y * size + x] = 255;
  }
  return alpha;
}

function pixel(out: { data: Uint8ClampedArray; width: number; pad: number }, x: number, y: number): number[] {
  const target = ((y + out.pad) * out.width + (x + out.pad)) * 4;
  return [out.data[target], out.data[target + 1], out.data[target + 2], out.data[target + 3]];
}

describe('computeOutlinePixels', () => {
  it('pads the bitmap so the rim is not clipped by the picture box', () => {
    const out = computeOutlinePixels(squareAlpha(), SIZE, SIZE, SPEC);
    expect(out).not.toBeNull();
    expect(out!.pad).toBe(PAD);
    expect(out!.width).toBe(SIZE + PAD * 2);
    expect(out!.height).toBe(SIZE + PAD * 2);
  });

  it('paints the rim outside the silhouette, never on the subject itself', () => {
    const out = computeOutlinePixels(squareAlpha(), SIZE, SIZE, SPEC)!;
    // 紧贴方块外侧一格（距离 1）：实心红环
    expect(pixel(out, 9, 20)).toEqual([0xff, 0x26, 0x38, 255]);
    expect(pixel(out, 30, 20)).toEqual([0xff, 0x26, 0x38, 255]);
    expect(pixel(out, 20, 9)).toEqual([0xff, 0x26, 0x38, 255]);
    // 方块内部：描边层什么都不画，主体由图片自己画
    for (const [x, y] of [
      [10, 10],
      [20, 20],
      [29, 29],
    ]) {
      expect(pixel(out, x, y)[3]).toBe(0);
    }
  });

  it('fades the halo with distance instead of stopping abruptly', () => {
    const out = computeOutlinePixels(squareAlpha(), SIZE, SIZE, SPEC)!;
    // 方块占 x∈[10,29]，所以外侧是 x<10；距离按 (10 - x) 数：x=9→1、6→4、5→5、4→6、3→7
    const rim = pixel(out, 9, 20)[3]; // d = 1 → 实心环
    const near = pixel(out, 6, 20)[3]; // d = 4 → 刚出实心环
    const mid = pixel(out, 5, 20)[3]; // d = 5
    const far = pixel(out, 4, 20)[3]; // d = 6 → 外晕末段
    expect(rim).toBe(255);
    expect(near).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(far);
    expect(far).toBeGreaterThan(0);
    // 再远一格（d = 7 = width + glow）就完全透明
    expect(pixel(out, 3, 20)[3]).toBe(0);
  });

  it('keeps the chosen colour and multiplies opacity', () => {
    const out = computeOutlinePixels(squareAlpha(), SIZE, SIZE, { ...SPEC, opacity: 0.5 })!;
    const [red, green, blue, alpha] = pixel(out, 9, 20);
    expect([red, green, blue]).toEqual([0xff, 0x26, 0x38]);
    expect(alpha).toBeGreaterThan(120);
    expect(alpha).toBeLessThan(135);
  });

  it('works on a thin, tall subject without inventing a rectangle', () => {
    const width = 6;
    const height = 60;
    const alpha = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y += 1) alpha[y * width + 2] = 255; // 一列像素
    const out = computeOutlinePixels(alpha, width, height, SPEC)!;
    expect(out).not.toBeNull();
    // 左边一格是环，第三列（主体上方）不画，隔两格以外全透明
    expect(pixel(out, 1, 30)[3]).toBe(255);
    expect(pixel(out, 2, 30)[3]).toBe(0);
    expect(pixel(out, 0, 30)[3]).toBeGreaterThan(0);
  });

  it('does nothing when the picture is fully transparent', () => {
    expect(computeOutlinePixels(new Uint8ClampedArray(SIZE * SIZE), SIZE, SIZE, SPEC)).toBeNull();
  });

  it('rejects a malformed buffer instead of reading past it', () => {
    expect(computeOutlinePixels(new Uint8ClampedArray(10), SIZE, SIZE, SPEC)).toBeNull();
  });
});

describe('outlineSpecOf', () => {
  it('is off by default so existing pictures keep their look', () => {
    expect(outlineSpecOf(DEFAULT_IMAGE_EFFECTS)).toBeNull();
  });

  it('turns on when both the width and the opacity are set', () => {
    const spec = outlineSpecOf({ ...DEFAULT_IMAGE_EFFECTS, outlineWidth: 4, outlineGlow: 14, outlineOpacity: 0.75 });
    expect(spec).toEqual({ width: 4, glow: 14, color: DEFAULT_IMAGE_EFFECTS.outlineColor, opacity: 0.75 });
  });

  it('stays off with a width but no opacity', () => {
    expect(outlineSpecOf({ ...DEFAULT_IMAGE_EFFECTS, outlineWidth: 4, outlineOpacity: 0 })).toBeNull();
  });
});
