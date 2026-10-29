/**
 * Six numbers that describe「拼完之后好看不好看」.
 *
 * Everything the pipeline did until now was per-picture: each slot solved its own
 * zoom against its own viewport. Nobody ever looked at the RESULT — three figures
 * could each be "correct" and still add up to a crowded, flat, edge-to-edge mess.
 * This module is the missing measuring pass: pure geometry over what was placed,
 * no model calls, no heuristics, same answer every time.
 *
 * What it deliberately is NOT:
 *  - not a scorer. It produces numbers; `fit-canvas-fill.ts` and `arrange-cascade.ts`
 *    decide what to do with them, and the panel shows them so a human can disagree.
 *  - not alpha-exact for the union. The union of N alpha masks is not computable in
 *    closed form; "how crowded does the page look" is about the SPACE a picture
 *    occupies anyway, so content boxes are the honest metric here.
 */

import type { AlphaProfile } from './alpha';
import { canvasOccupancy, contentRect, type CanvasSize, type ContentPlacement } from './coverage';
import { rectArea } from './rect';
import type { Rect } from './types';

export interface LayoutPicture {
  slotId: string;
  profile: AlphaProfile;
  placement: ContentPlacement;
}

export interface LayoutMargins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface LayoutMetrics {
  /** Union of the content boxes / canvas area. "how much of the page is used". */
  union: number;
  /** Largest occupancy / smallest occupancy. 1 means "every picture reads the same size". */
  hierarchy: number;
  /** Whitespace around the union box, in px. Negative means the content spills out. */
  margins: LayoutMargins;
  /** The tightest of the four margins, px — the number 留白 discussions are about. */
  minMargin: number;
  /**
   * Worst case of「a picture is hidden by one drawn above it」, as a fraction of the
   * hidden picture's box. Overlap is intended in a collage; burying one is not.
   */
  occlusion: number;
  /** Fraction of the biggest picture's box that the canvas cuts off. */
  cropped: number;
  /** Area-weighted centre of the clipped content, normalised to the canvas (0-1). */
  centroid: { x: number; y: number };
}

function clip(rect: Rect, canvas: CanvasSize): Rect | null {
  const left = Math.max(0, rect[0]);
  const top = Math.max(0, rect[1]);
  const right = Math.min(canvas.width, rect[2]);
  const bottom = Math.min(canvas.height, rect[3]);
  if (right <= left || bottom <= top) return null;
  return [left, top, right, bottom];
}

function intersect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[2], b[2]);
  const bottom = Math.min(a[3], b[3]);
  if (right <= left || bottom <= top) return null;
  return [left, top, right, bottom];
}

/**
 * Area of the union of up to four rects, exactly, by inclusion–exclusion.
 *
 * Four is the whole collage (backdrop / front / hero / package), so the 2^4 subsets
 * are cheaper than any sweep line and have no edge cases to get wrong.
 */
export function unionArea(rects: readonly Rect[]): number {
  const usable = rects.slice(0, 8);
  let total = 0;
  for (let mask = 1; mask < 1 << usable.length; mask += 1) {
    let accumulated: Rect | null = null;
    let picks = 0;
    for (let index = 0; index < usable.length; index += 1) {
      if ((mask & (1 << index)) === 0) continue;
      picks += 1;
      accumulated = accumulated ? intersect(accumulated, usable[index]) : usable[index];
      if (!accumulated) break;
    }
    if (!accumulated) continue;
    total += (picks % 2 === 1 ? 1 : -1) * rectArea(accumulated);
  }
  return total;
}

export function measureLayout(input: {
  pictures: readonly LayoutPicture[];
  canvas: CanvasSize;
}): LayoutMetrics {
  const { pictures, canvas } = input;
  const canvasArea = canvas.width * canvas.height;
  const canvasRects = pictures.map((picture) => contentRect(picture.profile, picture.placement));
  const visibleRects = canvasRects
    .map((rect) => clip(rect, canvas))
    .filter((rect): rect is Rect => rect !== null);
  const occupancies = pictures.map((picture) => canvasOccupancy(picture.profile, picture.placement, canvas));

  const union = canvasArea > 0 ? Math.min(1, unionArea(visibleRects) / canvasArea) : 0;

  const positive = occupancies.filter((value) => value > 0);
  const hierarchy = positive.length < 2 ? 1 : Math.max(...positive) / Math.min(...positive);

  const bone: Rect =
    visibleRects.length === 0
      ? [0, 0, 0, 0]
      : visibleRects.reduce<Rect>(
          (acc, rect) => [
            Math.min(acc[0], rect[0]),
            Math.min(acc[1], rect[1]),
            Math.max(acc[2], rect[2]),
            Math.max(acc[3], rect[3]),
          ],
          [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
        );
  /*
    Margins come from the VISIBLE part, so a picture that spills off the left edge
    reports a 0 margin instead of a negative one. `negativeSpill` would be a separate
    metric; "how much whitespace is left" is the question a seller asks.
  */
  const margins: LayoutMargins = {
    left: visibleRects.length === 0 ? canvas.width : bone[0],
    top: visibleRects.length === 0 ? canvas.height : bone[1],
    right: visibleRects.length === 0 ? canvas.width : canvas.width - bone[2],
    bottom: visibleRects.length === 0 ? canvas.height : canvas.height - bone[3],
  };
  const minMargin = Math.min(margins.left, margins.right, margins.top, margins.bottom);

  /*
    Occlusion is counted on the FULL boxes, not the clipped ones: a picture buried
    under another is buried whether or not the pair also pokes outside the canvas.
    Order matters — later entries are drawn above earlier ones (`render_order`).
  */
  let occlusion = 0;
  for (let back = 0; back < canvasRects.length; back += 1) {
    const box = canvasRects[back];
    const area = rectArea(box);
    if (area <= 0) continue;
    for (let front = back + 1; front < canvasRects.length; front += 1) {
      const overlap = intersect(box, canvasRects[front]);
      if (!overlap) continue;
      occlusion = Math.max(occlusion, Math.min(1, rectArea(overlap) / area));
    }
  }

  let cropped = 0;
  if (pictures.length > 0) {
    let biggest = 0;
    for (let index = 1; index < occupancies.length; index += 1) {
      if (occupancies[index] > occupancies[biggest]) biggest = index;
    }
    const box = canvasRects[biggest];
    const area = rectArea(box);
    const visible = clip(box, canvas);
    if (area > 0) cropped = Math.min(1, 1 - (visible ? rectArea(visible) / area : 0));
  }

  let sumArea = 0;
  let sumX = 0;
  let sumY = 0;
  for (const rect of visibleRects) {
    const area = rectArea(rect);
    sumArea += area;
    sumX += ((rect[0] + rect[2]) / 2) * area;
    sumY += ((rect[1] + rect[3]) / 2) * area;
  }
  const centroid =
    sumArea > 0
      ? { x: Math.round((sumX / sumArea / canvas.width) * 1000) / 1000, y: Math.round((sumY / sumArea / canvas.height) * 1000) / 1000 }
      : { x: 0.5, y: 0.5 };

  return {
    union: Math.round(union * 1000) / 1000,
    hierarchy: Math.round(hierarchy * 100) / 100,
    margins: {
      left: Math.round(margins.left),
      top: Math.round(margins.top),
      right: Math.round(margins.right),
      bottom: Math.round(margins.bottom),
    },
    minMargin: Math.round(minMargin),
    occlusion: Math.round(occlusion * 1000) / 1000,
    cropped: Math.round(cropped * 1000) / 1000,
    centroid,
  };
}
