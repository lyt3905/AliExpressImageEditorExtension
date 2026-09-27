import { describe, expect, it } from 'vitest';
import { CANVAS_SIZE, WATERMARK_LAYER_ID } from '../../src/shared/constants';
import type { WatermarkMeta } from '../../src/shared/types';
import { createWatermarkLayer, fitWatermarkToCanvas } from '../../src/editor/state/use-watermark';

function meta(width: number, height: number): WatermarkMeta {
  return {
    id: 'w1',
    name: '边框',
    blobId: 'watermark-w1',
    width,
    height,
    isDefault: true,
    createdAt: 1,
  };
}

describe('watermark placement', () => {
  it('fits a square frame exactly onto the canvas', () => {
    expect(fitWatermarkToCanvas(1600, 1600)).toEqual({ x: 400, y: 400, scale: 0.5 });
  });

  it('scales by the longest side, so the image is never stretched', () => {
    expect(fitWatermarkToCanvas(1600, 800)).toEqual({ x: CANVAS_SIZE / 2, y: CANVAS_SIZE / 2, scale: 0.5 });
    expect(fitWatermarkToCanvas(400, 1000)).toEqual({ x: CANVAS_SIZE / 2, y: CANVAS_SIZE / 2, scale: 0.8 });
  });

  it('falls back to scale 1 for a degenerate size', () => {
    expect(fitWatermarkToCanvas(0, 0)).toEqual({ x: CANVAS_SIZE / 2, y: CANVAS_SIZE / 2, scale: 1 });
  });

  it('builds a centred watermark layer with a fixed id', () => {
    const layer = createWatermarkLayer(meta(1600, 800));

    expect(layer).toEqual({
      id: WATERMARK_LAYER_ID,
      materialId: 'material-watermark-w1',
      blobId: 'watermark-w1',
      sourceWidth: 1600,
      sourceHeight: 800,
      x: CANVAS_SIZE / 2,
      y: CANVAS_SIZE / 2,
      scale: 0.5,
      rotation: 0,
      kind: 'watermark',
    });
  });

  it('substitutes the canvas size when the metadata has no usable dimensions', () => {
    const layer = createWatermarkLayer(meta(0, 0));
    expect(layer.sourceWidth).toBe(CANVAS_SIZE);
    expect(layer.sourceHeight).toBe(CANVAS_SIZE);
    expect(layer.scale).toBe(1);
  });

  it('is never given a rotation, so the frame always sits square on the canvas', () => {
    expect(createWatermarkLayer(meta(900, 600)).rotation).toBe(0);
  });
});
