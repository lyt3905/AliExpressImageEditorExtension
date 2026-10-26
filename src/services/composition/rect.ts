/**
 * Rectangle helpers for template-driven composition.
 *
 * IMPORTANT: a template's `box` is `[left, top, right, bottom]` — NOT
 * `[x, y, width, height]`. Three numbers in the shipped template only make sense
 * that way (`784 === 800 - 16`, `712 === footer top`, `185 > 180` clears the text
 * zone); read as w/h the viewport would run to 800x897 and leave the canvas.
 * `max_size` / `center` are a different convention on purpose (they describe a
 * target box, not a region), so the two must never be mixed up.
 *
 * Adjacency counts as "not overlapping": the comparisons are strict, so
 * `[0,712,800,800]` and `[16,185,784,712]` do not collide. That matters — the
 * footer reserved zone's top edge is exactly the hero viewport's bottom edge.
 */

import type { Point, Rect } from './types';

export function rectWidth(rect: Rect): number {
  return rect[2] - rect[0];
}

export function rectHeight(rect: Rect): number {
  return rect[3] - rect[1];
}

export function rectArea(rect: Rect): number {
  return Math.max(0, rectWidth(rect)) * Math.max(0, rectHeight(rect));
}

export function rectCenter(rect: Rect): Point {
  return [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
}

/** Build a rect from a centre point plus size (the convention `variants` use). */
export function rectFromCenter(center: Point, size: [number, number]): Rect {
  const halfWidth = size[0] / 2;
  const halfHeight = size[1] / 2;
  return [center[0] - halfWidth, center[1] - halfHeight, center[0] + halfWidth, center[1] + halfHeight];
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

export function intersectRect(a: Rect, b: Rect): Rect | null {
  if (!rectsIntersect(a, b)) return null;
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
}

export function intersectArea(a: Rect, b: Rect): number {
  const overlap = intersectRect(a, b);
  return overlap ? rectArea(overlap) : 0;
}

export function rectWithin(inner: Rect, outer: Rect): boolean {
  return inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];
}

/** `[l,t,r,b]` -> `{ x, y, width, height }` where x/y are the rect's CENTRE. */
export function rectToCenterBox(rect: Rect): { x: number; y: number; width: number; height: number } {
  const [x, y] = rectCenter(rect);
  return { x, y, width: rectWidth(rect), height: rectHeight(rect) };
}

/** Human-readable form used in validator messages. */
export function formatRect(rect: Rect): string {
  return `[${rect.map((value) => round2(value)).join(', ')}]`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
