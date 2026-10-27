import { describe, expect, it } from 'vitest';
import {
  paintAlphaHit,
  type AlphaHitScratch,
  type HitPaintContext,
  type ScratchPaintContext,
} from '../../src/editor/state/alpha-hit';

/*
  The subject here is a compositing invariant, so the test runs against a fake
  hit canvas that models the two composite operations that matter:

  - `source-over` writes the source where it is opaque and leaves everything
    else alone (what a hit canvas needs: shapes must accumulate, topmost wins);
  - `source-in` keeps the source only where the destination already has pixels,
    and makes the rest of the drawn rectangle transparent (what erased the lower
    layers' hit pixels when it was applied to the shared hit canvas directly).
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

const MASK = '<mask>';

class FakeHitContext implements HitPaintContext {
  readonly surface: Surface;
  readonly composites: string[] = [];
  readonly drawn: unknown[] = [];
  saves = 0;
  restores = 0;
  fillStyle = '#000000';
  composite = 'source-over';

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
      this.composite = String(value);
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

  drawImage(image: unknown, dx: number, dy: number): void {
    this.drawn.push(image);
    const source = image as Surface;
    for (let y = 0; y < source.height; y += 1) {
      for (let x = 0; x < source.width; x += 1) {
        const value = source.get(x, y);
        if (value === null) continue; // source-over: transparent source pixels keep the destination
        this.surface.set(dx + x, dy + y, value);
      }
    }
  }
}

class FakeScratch {
  readonly surface: Surface;
  readonly composites: string[] = [];
  globalCompositeOperation = 'source-over';
  fillStyle: string | CanvasGradient | CanvasPattern = '#000000';
  fillRects = 0;

  constructor(width: number, height: number) {
    this.surface = new Surface(width, height);
  }

  get canvas(): unknown {
    return this.surface;
  }

  setTransform(): void {}

  clearRect(x: number, y: number, width: number, height: number): void {
    for (let yy = y; yy < y + height; yy += 1) {
      for (let xx = x; xx < x + width; xx += 1) {
        this.surface.set(xx, yy, null);
      }
    }
  }

  drawImage(image: unknown, _dx: number, _dy: number, width: number, height: number): void {
    const mask = image as FakeImage;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (mask.opaque(x, y)) this.surface.set(x, y, MASK);
      }
    }
  }

  fillRect(x: number, y: number, width: number, height: number): void {
    this.fillRects += 1;
    this.composites.push(this.globalCompositeOperation);
    for (let yy = y; yy < y + height; yy += 1) {
      for (let xx = x; xx < x + width; xx += 1) {
        const existing = this.surface.get(xx, yy);
        if (this.globalCompositeOperation === 'source-in') {
          this.surface.set(xx, yy, existing === null ? null : String(this.fillStyle));
        } else if (existing !== null) {
          this.surface.set(xx, yy, String(this.fillStyle));
        }
      }
    }
  }
}

function scratchOf(fake: FakeScratch): AlphaHitScratch {
  return {
    canvas: fake.canvas as unknown as CanvasImageSource,
    context: fake as unknown as ScratchPaintContext,
  };
}

const IMAGE = 20;
/** Right half opaque, left half transparent — a cut-out with a wide empty margin. */
const RIGHT_HALF: FakeImage = {
  width: IMAGE,
  height: IMAGE,
  opaque: (x) => x >= 10,
};

const KEY = '#222222';
const BELOW = '#111111';

function paint(hit: FakeHitContext, image: FakeImage, scratch: FakeScratch | null): void {
  paintAlphaHit(
    hit,
    { sourceWidth: IMAGE, sourceHeight: IMAGE, colorKey: KEY },
    image as unknown as CanvasImageSource,
    scratch ? scratchOf(scratch) : null,
  );
}

describe('paintAlphaHit', () => {
  it('keeps the hit pixels a layer underneath already registered', () => {
    const hit = new FakeHitContext(IMAGE, IMAGE);
    // The lower layer registered the whole left strip as hit-able.
    for (let y = 0; y < IMAGE; y += 1) {
      for (let x = 0; x < 5; x += 1) hit.surface.set(x, y, BELOW);
    }

    paint(hit, RIGHT_HALF, new FakeScratch(IMAGE, IMAGE));

    // This is the regression: the upper picture is transparent here, and the
    // lower layer used to lose its hit pixel to the `source-in` composite.
    expect(hit.surface.get(2, 5)).toBe(BELOW);
    // Where the upper picture is opaque it wins, as z-order says it should.
    expect(hit.surface.get(15, 5)).toBe(KEY);
    // Nothing was invented in the gap between the two shapes.
    expect(hit.surface.get(7, 5)).toBeNull();
  });

  it('never composites source-in onto the shared hit canvas', () => {
    const hit = new FakeHitContext(IMAGE, IMAGE);
    const scratch = new FakeScratch(IMAGE, IMAGE);

    paint(hit, RIGHT_HALF, scratch);

    expect(hit.composites).not.toContain('source-in');
    expect(hit.composites).toEqual(['source-over']);
    // The destructive composite happened off to the side instead.
    expect(scratch.composites).toEqual(['source-in']);
    expect(hit.drawn).toEqual([scratch.surface]);
  });

  it('paints an upper layer over a lower one where both are opaque', () => {
    const hit = new FakeHitContext(IMAGE, IMAGE);
    paint(hit, RIGHT_HALF, new FakeScratch(IMAGE, IMAGE));

    const upper = new FakeScratch(IMAGE, IMAGE);
    paintAlphaHit(
      hit,
      { sourceWidth: IMAGE, sourceHeight: IMAGE, colorKey: '#333333' },
      { width: IMAGE, height: IMAGE, opaque: (x: number) => x >= 15 } as unknown as CanvasImageSource,
      scratchOf(upper),
    );

    expect(hit.surface.get(16, 4)).toBe('#333333');
    expect(hit.surface.get(12, 4)).toBe(KEY);
  });

  it('reuses one mask surface for consecutive layers', () => {
    const hit = new FakeHitContext(IMAGE, IMAGE);
    const scratch = new FakeScratch(IMAGE, IMAGE);

    paint(hit, RIGHT_HALF, scratch);
    // A second layer with a mask that covers the opposite half must not inherit
    // leftover pixels from the first one.
    paintAlphaHit(
      hit,
      { sourceWidth: IMAGE, sourceHeight: IMAGE, colorKey: '#444444' },
      { width: IMAGE, height: IMAGE, opaque: (x: number) => x < 5 } as unknown as CanvasImageSource,
      scratchOf(scratch),
    );

    expect(hit.surface.get(3, 3)).toBe('#444444');
    expect(hit.surface.get(15, 3)).toBe(KEY);
  });

  it('falls back to the whole rectangle when no mask surface is available', () => {
    const hit = new FakeHitContext(IMAGE, IMAGE);

    paint(hit, RIGHT_HALF, null);

    // A picture that cannot be clicked at all is worse than one whose transparent
    // corners are clickable.
    expect(hit.surface.get(1, 1)).toBe(KEY);
    expect(hit.surface.get(18, 18)).toBe(KEY);
  });

  it('ignores a degenerate box and still balances save/restore', () => {
    const hit = new FakeHitContext(IMAGE, IMAGE);
    const scratch = new FakeScratch(IMAGE, IMAGE);

    paintAlphaHit(
      hit,
      { sourceWidth: 0, sourceHeight: IMAGE, colorKey: KEY },
      RIGHT_HALF as unknown as CanvasImageSource,
      scratchOf(scratch),
    );

    expect(hit.surface.pixels.every((value) => value === null)).toBe(true);
    expect(scratch.fillRects).toBe(0);
    expect(hit.saves).toBe(0);
  });

  it('balances save and restore when it does paint', () => {
    const hit = new FakeHitContext(IMAGE, IMAGE);

    paint(hit, RIGHT_HALF, new FakeScratch(IMAGE, IMAGE));
    paint(hit, RIGHT_HALF, null);

    expect(hit.saves).toBe(hit.restores);
  });
});
