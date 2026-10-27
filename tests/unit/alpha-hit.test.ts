import { describe, expect, it } from 'vitest';
import {
  createAlphaHitMasks,
  type AlphaHitTarget,
  type HitPaintContext,
  type MaskPaintContext,
  type MaskSurface,
} from '../../src/editor/state/alpha-hit';

/*
  The subject here is a compositing invariant, so the test runs against a fake hit
  canvas that models the two composite operations that matter:

  - `source-over` writes the source where it is opaque and leaves everything else
    alone (what a hit canvas needs: shapes accumulate, topmost wins);
  - `source-in` keeps the source only where the destination already has pixels, and
    makes the rest of the drawn rectangle transparent (what erased the lower
    layers' hit pixels when it was applied to the shared hit canvas directly).

  Since the fix moved that destructive composite onto an offscreen canvas, the test
  also asserts *where* each operation happened: masks may use `source-in`, the hit
  canvas never may.
*/

class Surface {
  readonly width: number;
  readonly height: number;
  pixels: (string | null)[];

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.pixels = new Array<string | null>(width * height).fill(null);
  }

  get(x: number, y: number): string | null {
    return this.pixels[y * this.width + x] ?? null;
  }

  set(x: number, y: number, value: string | null): void {
    this.pixels[y * this.width + x] = value;
  }
}

/** Opaque mask: `true` marks a pixel the picture actually covers. */
interface FakeImage {
  width: number;
  height: number;
  opaque: (x: number, y: number) => boolean;
}

const IMAGE_PIXEL = '<image>';
const KEY = '#222222';
const BELOW = '#111111';

class FakeHitContext implements HitPaintContext {
  readonly surface: Surface;
  readonly composites: string[] = [];
  readonly drawn: unknown[] = [];
  saves = 0;
  restores = 0;
  fillStyle = '#000000';

  constructor(width: number, height: number) {
    this.surface = new Surface(width, height);
  }

  save(): void {
    this.saves += 1;
  }

  restore(): void {
    this.restores += 1;
  }

  setAttr(attribute: string, value: unknown): void {
    if (attribute === 'globalCompositeOperation') {
      this.composites.push(String(value));
    } else if (attribute === 'fillStyle') {
      this.fillStyle = String(value);
    }
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    for (let yy = y; yy < y + height; yy += 1) {
      for (let xx = x; xx < x + width; xx += 1) {
        this.surface.set(xx, yy, this.fillStyle);
      }
    }
  }

  /** Hit painting always uses `source-over`: only adds pixels. */
  drawImage(image: unknown, dx: number, dy: number, width?: number, height?: number): void {
    this.drawn.push(image);
    const source = image as Surface;
    const targetWidth = width ?? source.width;
    const targetHeight = height ?? source.height;
    for (let y = 0; y < targetHeight; y += 1) {
      for (let x = 0; x < targetWidth; x += 1) {
        const sx = Math.min(source.width - 1, Math.floor((x / targetWidth) * source.width));
        const sy = Math.min(source.height - 1, Math.floor((y / targetHeight) * source.height));
        const value = source.get(sx, sy);
        if (value === null) continue; // source-over keeps the destination
        this.surface.set(dx + x, dy + y, value);
      }
    }
  }
}

/** A stand-in for the offscreen 2D context a mask is rasterised in. */
class FakeMaskContext {
  globalCompositeOperation = 'source-over';
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  readonly composites: string[] = [];
  readonly drawn: FakeImage[] = [];

  constructor(private readonly surface: Surface) {}

  drawImage(image: unknown, _dx: number, _dy: number, width: number, height: number): void {
    const source = image as FakeImage;
    this.drawn.push(source);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const sx = Math.min(source.width - 1, Math.floor((x / width) * source.width));
        const sy = Math.min(source.height - 1, Math.floor((y / height) * source.height));
        if (source.opaque(sx, sy)) this.surface.set(x, y, IMAGE_PIXEL);
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    const composite = this.globalCompositeOperation;
    this.composites.push(composite);
    for (let yy = y; yy < y + height; yy += 1) {
      for (let xx = x; xx < x + width; xx += 1) {
        if (composite === 'source-in') {
          // Keep only where the destination already has pixels — that is exactly
          // what made this operation destructive when it ran on the hit canvas.
          const existing = this.surface.get(xx, yy);
          this.surface.set(xx, yy, existing === null ? null : String(this.fillStyle));
        } else {
          this.surface.set(xx, yy, String(this.fillStyle));
        }
      }
    }
  }
}

class Harness {
  readonly masks;
  readonly surfaces: { width: number; height: number; context: FakeMaskContext }[] = [];

  constructor(maxSide?: number) {
    this.masks = createAlphaHitMasks({
      maxSide,
      createSurface: (width, height): MaskSurface | null => {
        const surface = new Surface(width, height);
        const context = new FakeMaskContext(surface);
        this.surfaces.push({ width, height, context });
        return {
          canvas: surface as unknown as CanvasImageSource,
          context: context as unknown as MaskPaintContext,
        };
      },
    });
  }
}

const SIZE = 20;
/** Right half opaque, left half transparent — a cut-out with a wide empty margin. */
const RIGHT_HALF: FakeImage = { width: SIZE, height: SIZE, opaque: (x) => x >= 10 };
const LEFT_STRIP: FakeImage = { width: SIZE, height: SIZE, opaque: (x) => x < 5 };

function target(colorKey = KEY, size = SIZE): AlphaHitTarget {
  return { sourceWidth: size, sourceHeight: size, colorKey };
}

function paint(hit: FakeHitContext, image: FakeImage, masks = new Harness().masks): void {
  masks.paint(hit, target(), image as unknown as CanvasImageSource);
}

describe('paintAlphaHit', () => {
  it('keeps the hit pixels a layer underneath already registered', () => {
    const hit = new FakeHitContext(SIZE, SIZE);
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < 5; x += 1) hit.surface.set(x, y, BELOW);
    }

    paint(hit, RIGHT_HALF);

    // The regression: the upper picture is transparent here, and the lower layer
    // used to lose its hit pixel to the `source-in` composite.
    expect(hit.surface.get(2, 5)).toBe(BELOW);
    // Where the upper picture is opaque it wins, as z-order says it should.
    expect(hit.surface.get(15, 5)).toBe(KEY);
    // Nothing was invented in the gap between the two shapes.
    expect(hit.surface.get(7, 5)).toBeNull();
  });

  it('never composites source-in onto the hit canvas', () => {
    const harness = new Harness();
    const hit = new FakeHitContext(SIZE, SIZE);

    paint(hit, RIGHT_HALF, harness.masks);

    expect(hit.composites).not.toContain('source-in');
    expect(hit.composites).toEqual(['source-over']);
    // The destructive composite happened off to the side instead.
    expect(harness.surfaces[0].context.composites).toEqual(['source-in']);
    expect(hit.drawn).toHaveLength(1);
  });

  it('paints an upper layer over a lower one where both are opaque', () => {
    const masks = new Harness().masks;
    const hit = new FakeHitContext(SIZE, SIZE);
    paint(hit, RIGHT_HALF, masks);

    const upper: FakeImage = { width: SIZE, height: SIZE, opaque: (x) => x >= 15 };
    masks.paint(hit, target('#333333'), upper as unknown as CanvasImageSource);

    expect(hit.surface.get(16, 4)).toBe('#333333');
    expect(hit.surface.get(12, 4)).toBe(KEY);
  });

  it('rasterises each picture once and reuses the mask', () => {
    const harness = new Harness();
    const hit = new FakeHitContext(SIZE, SIZE);

    paint(hit, RIGHT_HALF, harness.masks);
    paint(hit, RIGHT_HALF, harness.masks);
    paint(hit, RIGHT_HALF, harness.masks);

    // This is the cost that used to be paid on every redraw: the mask does not
    // depend on the frame, so it must not be rebuilt for one.
    expect(harness.surfaces).toHaveLength(1);
    expect(harness.masks.builds).toBe(1);
    expect(hit.drawn).toHaveLength(3);
  });

  it('rebuilds the mask when the hit colour changes', () => {
    const harness = new Harness();
    const hit = new FakeHitContext(SIZE, SIZE);

    paint(hit, RIGHT_HALF, harness.masks);
    harness.masks.paint(hit, target('#444444'), RIGHT_HALF as unknown as CanvasImageSource);

    // Konva assigns a fresh `colorKey` per shape, so two layers showing the same
    // picture cannot share a mask.
    expect(harness.masks.builds).toBe(2);
    expect(hit.surface.get(15, 3)).toBe('#444444');
  });

  it('does not let one picture inherit the pixels of another', () => {
    const harness = new Harness();
    const hit = new FakeHitContext(SIZE, SIZE);

    paint(hit, RIGHT_HALF, harness.masks);
    paint(hit, LEFT_STRIP, harness.masks);

    expect(hit.surface.get(3, 3)).toBe(KEY);
    expect(hit.surface.get(15, 3)).toBe(KEY);
    // Each mask is its own canvas, so the second picture's empty half stays empty
    // instead of picking up leftovers from the first.
    expect(hit.surface.get(7, 3)).toBeNull();
    expect(harness.surfaces).toHaveLength(2);
  });

  it('caps the mask at the preview resolution', () => {
    const harness = new Harness(10);
    const hit = new FakeHitContext(40, 20);

    harness.masks.paint(
      hit,
      { sourceWidth: 40, sourceHeight: 20, colorKey: KEY },
      RIGHT_HALF as unknown as CanvasImageSource,
    );

    // 40x20 capped at 10 keeps the aspect ratio: 10x5.
    expect(harness.surfaces.at(-1)).toMatchObject({ width: 10, height: 5 });
    // ...and is scaled back onto the full box when painted, so hit coordinates
    // are unchanged.
    expect(hit.surface.get(30, 2)).toBe(KEY);
    expect(hit.surface.get(5, 2)).toBeNull();
  });

  it('falls back to the whole rectangle when no mask canvas is available', () => {
    const masks = createAlphaHitMasks({ createSurface: () => null });
    const hit = new FakeHitContext(SIZE, SIZE);

    paint(hit, RIGHT_HALF, masks);

    // A picture that cannot be clicked at all is worse than one whose transparent
    // corners are clickable.
    expect(hit.surface.get(1, 1)).toBe(KEY);
    expect(hit.surface.get(18, 18)).toBe(KEY);
    expect(masks.builds).toBe(0);
  });

  it('ignores a degenerate box and still balances save/restore', () => {
    const harness = new Harness();
    const hit = new FakeHitContext(SIZE, SIZE);

    harness.masks.paint(
      hit,
      { sourceWidth: 0, sourceHeight: SIZE, colorKey: KEY },
      RIGHT_HALF as unknown as CanvasImageSource,
    );

    expect(hit.surface.pixels.every((value) => value === null)).toBe(true);
    expect(harness.surfaces).toHaveLength(0);
    expect(hit.saves).toBe(0);
  });

  it('balances save and restore when it does paint', () => {
    const hit = new FakeHitContext(SIZE, SIZE);

    paint(hit, RIGHT_HALF);
    paint(hit, RIGHT_HALF);

    expect(hit.saves).toBe(2);
    expect(hit.saves).toBe(hit.restores);
  });

  it('forgets cached masks on clear()', () => {
    const harness = new Harness();
    const hit = new FakeHitContext(SIZE, SIZE);

    paint(hit, RIGHT_HALF, harness.masks);
    harness.masks.clear();
    expect(harness.masks.builds).toBe(0);

    paint(hit, RIGHT_HALF, harness.masks);
    expect(harness.masks.builds).toBe(1);
    expect(harness.surfaces).toHaveLength(2);
  });
});
