import { describe, expect, it } from 'vitest';
import { fitInside } from '../../src/editor/state/fit-inside';

describe('fitInside', () => {
  it('leaves a box that already fits', () => {
    expect(fitInside(800, 600, 1024)).toEqual({ width: 800, height: 600 });
  });

  it('scales the longest side down to the cap and keeps the ratio', () => {
    expect(fitInside(1600, 1200, 1024)).toEqual({ width: 1024, height: 768 });
    expect(fitInside(1200, 1600, 1024)).toEqual({ width: 768, height: 1024 });
  });

  it('rounds both sides', () => {
    expect(fitInside(1600, 1000, 1024)).toEqual({ width: 1024, height: 640 });
    // 3:2 at 1024 is 682.67 -> 683; the ratio is off by a pixel, which is why both
    // the mask and the drawing source must use the same helper.
    expect(fitInside(3000, 2000, 1024)).toEqual({ width: 1024, height: 683 });
  });

  it('never returns a zero side', () => {
    expect(fitInside(4000, 1, 1024)).toEqual({ width: 1024, height: 1 });
  });

  it('returns 0x0 for a degenerate input', () => {
    expect(fitInside(0, 100, 1024)).toEqual({ width: 0, height: 0 });
    expect(fitInside(100, 0, 1024)).toEqual({ width: 0, height: 0 });
    expect(fitInside(100, 100, 0)).toEqual({ width: 0, height: 0 });
  });
});
