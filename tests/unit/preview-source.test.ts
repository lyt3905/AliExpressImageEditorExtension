import { describe, expect, it } from 'vitest';
import {
  createPreviewSources,
  PREVIEW_SOURCE_MAX_SIDE,
  quantiseScale,
  type PreviewSourceCanvas,
} from '../../src/editor/state/preview-source';

/*
  A downscaled drawing source is only correct if it changes *nothing* except the
  pixels Konva samples: same box, same position, so hit areas and the exported
  frame stay put. These tests pin that contract, the size rules that make the
  change worth having (one copy per picture, never larger than what is drawn), and
  the bucketing that keeps a transformer drag from rebuilding it per frame.
*/

class FakeCanvas {
  readonly calls: { image: unknown; width: number; height: number }[] = [];
  imageSmoothingEnabled = false;
  imageSmoothingQuality: ImageSmoothingQuality = 'low';

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  drawImage(image: unknown, _dx: number, _dy: number, width: number, height: number): void {
    this.calls.push({ image, width, height });
  }
}

function harness(options: { maxSide?: number; canvas?: boolean } = {}) {
  const created: FakeCanvas[] = [];
  const sources = createPreviewSources({
    maxSide: options.maxSide,
    createCanvas:
      options.canvas === false
        ? () => null
        : (width, height) => {
            const canvas = new FakeCanvas(width, height);
            created.push(canvas);
            return {
              canvas: canvas as unknown as CanvasImageSource,
              context: canvas as unknown as PreviewSourceCanvas['context'],
            };
          },
  });
  return { sources, created };
}

/** A 1600x1600 cut-out: the biggest thing `CUTOUT_MAX_SIZE` allows. */
const BIG = { naturalWidth: 1600, naturalHeight: 1600 };
const SMALL = { naturalWidth: 800, naturalHeight: 800 };

describe('previewSources', () => {
  it('defaults to a cap above the export canvas', () => {
    // The export is 800x800, so a copy smaller than that would throw away detail.
    expect(PREVIEW_SOURCE_MAX_SIDE).toBeGreaterThanOrEqual(1024);
  });

  it('draws the original when the picture already fits', () => {
    const { sources, created } = harness();

    const source = sources.for(SMALL, 800, 800);

    expect(source).toEqual({ image: SMALL, width: 800, height: 800, original: true });
    expect(created).toHaveLength(0);
    expect(sources.builds).toBe(0);
  });

  it('downscales a big cut-out to the size it is actually drawn at', () => {
    const { sources, created } = harness();

    // A composed hero: 1600 px of source shown at a quarter size.
    const source = sources.for(BIG, 1600, 1600, 0.25);

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ width: 400, height: 400 });
    expect(created[0].calls).toEqual([{ image: BIG, width: 400, height: 400 }]);
    expect(source).toMatchObject({ width: 1600, height: 1600, original: false });
    expect(sources.builds).toBe(1);
  });

  it('never builds a copy larger than the cap', () => {
    const { sources, created } = harness();

    // Drawn at full source size — still capped, because the canvas is 800 px wide.
    const source = sources.for(BIG, 1600, 1600, 1);

    expect(created[0]).toMatchObject({ width: 1024, height: 1024 });
    expect(source?.original).toBe(false);
  });

  it('keeps the layer box, not the picture natural size', () => {
    const { sources, created } = harness();
    const picture = { naturalWidth: 1600, naturalHeight: 1200 };

    const source = sources.for(picture, 1600, 1200, 0.25);

    expect(created[0]).toMatchObject({ width: 400, height: 300 });
    // The node keeps drawing into the exact box it had before.
    expect(source).toMatchObject({ width: 1600, height: 1200 });
  });

  it('rounds the scale up so the copy is never too small', () => {
    const { sources, created } = harness();

    // 0.3 draws 480 px but rounds up to the 0.5 bucket: sharper, one canvas either way.
    sources.for(BIG, 1600, 1600, 0.3);

    expect(created[0]).toMatchObject({ width: 800, height: 800 });
  });

  it('builds the copy once and reuses it', () => {
    const { sources, created } = harness();

    const first = sources.for(BIG, 1600, 1600, 0.25);
    const second = sources.for(BIG, 1600, 1600, 0.25);

    // Dragging re-renders constantly; this must not reconstruct anything.
    expect(created).toHaveLength(1);
    expect(second).toBe(first);
    expect(sources.builds).toBe(1);
  });

  it('keeps the copy while the scale stays inside its bucket', () => {
    const { sources, created } = harness();

    sources.for(BIG, 1600, 1600, 0.25);
    sources.for(BIG, 1600, 1600, 0.25);
    sources.for(BIG, 1600, 1600, 0.25);

    expect(created).toHaveLength(1);
  });

  it('rebuilds only when the pointer crosses a bucket', () => {
    const { sources, created } = harness();

    sources.for(BIG, 1600, 1600, 0.25); // 0.25 bucket: 400 px
    sources.for(BIG, 1600, 1600, 0.2); // also the 0.25 bucket
    expect(created).toHaveLength(1);

    const next = sources.for(BIG, 1600, 1600, 0.3); // 0.5 bucket: 800 px
    expect(created).toHaveLength(2);
    expect(created[1]).toMatchObject({ width: 800, height: 800 });
    expect(next?.original).toBe(false);
  });

  it('holds one copy per picture', () => {
    const { sources } = harness();

    sources.for(BIG, 1600, 1600, 0.25);
    sources.for(BIG, 1600, 1600, 0.75);

    // Only the size in use is kept — otherwise a transformer drag would pile up
    // 4 MB canvases for every bucket it passed through.
    expect(sources.builds).toBe(2);
  });

  it('asks for the best smoothing the browser offers', () => {
    const { sources, created } = harness();

    sources.for(BIG, 1600, 1600, 0.25);

    expect(created[0].imageSmoothingEnabled).toBe(true);
    expect(created[0].imageSmoothingQuality).toBe('high');
  });

  it('falls back to the original when no canvas can be created', () => {
    const { sources } = harness({ canvas: false });

    const source = sources.for(BIG, 1600, 1600, 0.25);

    // Paying the per-frame cost beats drawing nothing.
    expect(source).toEqual({ image: BIG, width: 1600, height: 1600, original: true });
    expect(sources.builds).toBe(0);
  });

  it('returns null while the picture has no usable size', () => {
    const { sources } = harness();

    // A picture that has not decoded yet reports 0x0; drawing it would collapse
    // the layer's box.
    expect(sources.for({}, 800, 800)).toBeNull();
    expect(sources.for({ naturalWidth: 0, naturalHeight: 0 }, 800, 800)).toBeNull();
  });

  it('returns null for a degenerate box', () => {
    const { sources } = harness();

    expect(sources.for(BIG, 0, 800)).toBeNull();
    expect(sources.for(BIG, 800, 0)).toBeNull();
  });

  it('falls back to width/height when natural size is missing', () => {
    const { sources } = harness();

    expect(sources.for({ width: 300, height: 200 }, 300, 200)?.original).toBe(true);
  });

  it('forgets cached copies on clear()', () => {
    const { sources, created } = harness();

    sources.for(BIG, 1600, 1600, 0.25);
    sources.clear();
    expect(sources.builds).toBe(0);

    sources.for(BIG, 1600, 1600, 0.25);
    expect(created).toHaveLength(2);
  });
});

describe('quantiseScale', () => {
  it('keeps exact bucket values', () => {
    expect(quantiseScale(0.25)).toBe(0.25);
    expect(quantiseScale(0.5)).toBe(0.5);
    expect(quantiseScale(1)).toBe(1);
  });

  it('rounds anything else up', () => {
    expect(quantiseScale(0.26)).toBe(0.5);
    expect(quantiseScale(2.1)).toBe(2.25);
  });

  it('treats a missing or nonsensical scale as 1', () => {
    expect(quantiseScale(0)).toBe(1);
    expect(quantiseScale(-2)).toBe(1);
    expect(quantiseScale(Number.NaN)).toBe(1);
  });

  it('never goes below one bucket', () => {
    expect(quantiseScale(0.01)).toBe(0.25);
  });
});
