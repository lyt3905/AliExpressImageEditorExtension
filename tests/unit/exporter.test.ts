import { afterEach, describe, expect, it } from 'vitest';
import { CANVAS_SIZE } from '../../src/shared/constants';
import {
  buildExportFileName,
  exportStageToPng,
  normaliseToCanvasSize,
} from '../../src/services/exporter';

describe('buildExportFileName', () => {
  it('produces the documented aliexpress-composite-<date>-<time>.png shape', () => {
    const name = buildExportFileName(new Date(2026, 8, 27, 11, 45, 0));
    expect(name).toBe('aliexpress-composite-20260927-114500.png');
    expect(name).toMatch(/^aliexpress-composite-\d{8}-\d{6}\.png$/);
  });

  it('zero-pads every component', () => {
    expect(buildExportFileName(new Date(2026, 0, 2, 3, 4, 5))).toBe('aliexpress-composite-20260102-030405.png');
  });
});

describe('export constants', () => {
  it('locks the export to 800x800', () => {
    expect(CANVAS_SIZE).toBe(800);
  });
});

// ---------------------------------------------------------------- export sizing
//
// Konva does `canvas.width = width * pixelRatio` with no rounding, so the product
// must land exactly on 800. The DOM is stubbed here because these tests run under
// `environment: 'node'`.

interface FakeCanvas {
  width: number;
  height: number;
  getContext: (kind: string) => unknown;
  toBlob: (callback: (blob: Blob | null) => void, mime?: string, quality?: number) => void;
}

const drawCalls: unknown[][] = [];

function makeCanvas(width: number, height: number): FakeCanvas {
  return {
    width,
    height,
    getContext: () => ({
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      drawImage: (...args: unknown[]) => {
        drawCalls.push(args);
      },
    }),
    toBlob: (callback) => callback(new Blob([new Uint8Array([1])])),
  };
}

function stubDocument(): void {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: () => makeCanvas(0, 0),
  };
}

function makeStage(stageWidth: number, stageHeight: number, produced: { width: number; height: number }) {
  const received: { pixelRatio?: number; width?: number } = {};
  const stage = {
    width: () => stageWidth,
    height: () => stageHeight,
    toCanvas: (config: { pixelRatio: number; width: number }) => {
      received.pixelRatio = config.pixelRatio;
      received.width = config.width;
      return makeCanvas(produced.width, produced.height);
    },
  };
  return { stage: stage as never, received };
}

afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
  drawCalls.length = 0;
});

describe('normaliseToCanvasSize', () => {
  it('returns the rendered canvas untouched when it is already 800x800', () => {
    stubDocument();
    const canvas = makeCanvas(CANVAS_SIZE, CANVAS_SIZE);
    expect(normaliseToCanvasSize(canvas as unknown as HTMLCanvasElement)).toBe(canvas);
    expect(drawCalls).toHaveLength(0);
  });

  it('redraws a 799x799 render into an exact 800x800 canvas', () => {
    stubDocument();
    const canvas = makeCanvas(799, 799);
    const fixed = normaliseToCanvasSize(canvas as unknown as HTMLCanvasElement);
    expect(fixed).not.toBe(canvas);
    expect([fixed.width, fixed.height]).toEqual([800, 800]);
    expect(drawCalls).toHaveLength(1);
    // Stretched back to the intended geometry instead of shipping one pixel short.
    expect(drawCalls[0]!.slice(1)).toEqual([0, 0, 800, 800]);
  });

  it('refuses a gross mismatch instead of quietly rescaling it', () => {
    stubDocument();
    const canvas = makeCanvas(630, 630);
    expect(() => normaliseToCanvasSize(canvas as unknown as HTMLCanvasElement)).toThrow(/导出尺寸异常/);
  });
});

describe('exportStageToPng — sizing', () => {
  it('documents the float trap the old formula fell into', () => {
    // previewScale = S/800, then 1/previewScale: two roundings. 254 is one of the
    // 35 preview sizes where the product lands just under 800.
    const failing = 254;
    expect(Math.floor(failing * (1 / (failing / CANVAS_SIZE)))).toBe(799);
    // One division instead: 27 of those 35 are fixed outright.
    expect(Math.floor(failing * (CANVAS_SIZE / failing))).toBe(800);
  });

  it('derives the ratio from the stage width', async () => {
    stubDocument();
    const { stage, received } = makeStage(398, 398, { width: 800, height: 800 });
    const blob = await exportStageToPng(stage);
    expect(received.pixelRatio).toBeCloseTo(800 / 398, 12);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('still succeeds when the render lands one pixel short', async () => {
    stubDocument();
    const { stage } = makeStage(398, 398, { width: 799, height: 799 });
    const blob = await exportStageToPng(stage);
    expect(blob.size).toBeGreaterThan(0);
    expect(drawCalls).toHaveLength(1);
  });

  it('runs the hooks around a corrected export too', async () => {
    stubDocument();
    const { stage } = makeStage(398, 398, { width: 799, height: 799 });
    const order: string[] = [];
    await exportStageToPng(stage, {
      hooks: { before: () => order.push('before'), after: () => order.push('after') },
    });
    expect(order).toEqual(['before', 'after']);
  });

  it('is exact for every even preview size the stage can take', () => {
    // The invariant, over the whole supported range rather than a few samples:
    // whatever the window size, the exported canvas is 800x800.
    stubDocument();
    const failures: string[] = [];
    for (let stageSize = 240; stageSize <= 640; stageSize += 2) {
      // Mimic Konva (`width * pixelRatio`) + the DOM (truncation) with the new ratio.
      const truncated = Math.floor(stageSize * (CANVAS_SIZE / stageSize));
      const fixed = normaliseToCanvasSize(makeCanvas(truncated, truncated) as unknown as HTMLCanvasElement);
      if (fixed.width !== CANVAS_SIZE || fixed.height !== CANVAS_SIZE) {
        failures.push(`stage=${stageSize} -> ${fixed.width}x${fixed.height}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('rejects a gross mismatch and still restores the UI', async () => {
    stubDocument();
    const { stage } = makeStage(398, 398, { width: 630, height: 630 });
    const order: string[] = [];
    await expect(
      exportStageToPng(stage, {
        hooks: { before: () => order.push('before'), after: () => order.push('after') },
      }),
    ).rejects.toThrow(/导出尺寸异常/);
    expect(order).toEqual(['before', 'after']);
  });
});
