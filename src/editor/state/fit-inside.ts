/**
 * Scale a box down until its longest side fits `maxSide`, keeping the aspect
 * ratio.
 *
 * Two places in the editor need a downscaled copy of a picture and both must use
 * the same rounding, otherwise a mask and the drawing it masks disagree by a
 * pixel: the alpha hit mask (`state/alpha-hit.ts`) and the preview source
 * (`state/preview-source.ts`).
 */

export interface FitSize {
  width: number;
  height: number;
}

export function fitInside(width: number, height: number, maxSide: number): FitSize {
  if (!(width > 0) || !(height > 0) || !(maxSide > 0)) return { width: 0, height: 0 };

  const longest = Math.max(width, height);
  if (longest <= maxSide) return { width: Math.round(width), height: Math.round(height) };

  const ratio = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}
