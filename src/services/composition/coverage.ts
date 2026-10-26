/**
 * Geometry over alpha profiles: "where does this material land, and how much of
 * it is actually visible?"
 *
 * All functions are pure and allocation-light so a solver can call them a
 * hundred times per material (the zoom search does exactly that).
 *
 * Coordinates: `ContentPlacement` describes the TRIMMED product, not the source
 * canvas. That is the important part — a cut-out PNG is usually a 1600x1600
 * canvas with the product floating in the middle, so scaling the canvas to a
 * target box would make every product look small and off-centre. Everything here
 * works on the trimmed box and `toLayerPlacement` folds the trim offset back in
 * exactly once, on the way out.
 */

import type { AlphaProfile } from './alpha';
import { maskCoverage } from './alpha';
import { rectArea } from './rect';
import type { Rect } from './types';

export interface CanvasSize {
  width: number;
  height: number;
}

/** Logical placement of the TRIMMED content: centre plus px-per-source-px. */
export interface ContentPlacement {
  centerX: number;
  centerY: number;
  scale: number;
}

export interface ContentExtent {
  width: number;
  height: number;
}

export function contentExtent(profile: AlphaProfile, scale: number): ContentExtent {
  return { width: profile.trim.width * scale, height: profile.trim.height * scale };
}

/** The trimmed content's rect in canvas logic space, as `[l, t, r, b]`. */
export function contentRect(profile: AlphaProfile, placement: ContentPlacement): Rect {
  const { width, height } = contentExtent(profile, placement.scale);
  return [
    placement.centerX - width / 2,
    placement.centerY - height / 2,
    placement.centerX + width / 2,
    placement.centerY + height / 2,
  ];
}

/**
 * Sum alpha coverage of the placed content inside `region`.
 *
 * Each mask cell is treated as uniformly covered, so a cell straddling the
 * region edge contributes its overlap area times its coverage. For a partially
 * covered edge cell that is an approximation, bounded by one cell's area; with a
 * 128² mask over a ~600px product a cell is ~5px, i.e. well below the noise in a
 * 0.34 occupancy threshold.
 */
function alphaAreaWithin(
  profile: AlphaProfile,
  placement: ContentPlacement,
  region: Rect,
): number {
  const { width, height } = contentExtent(profile, placement.scale);
  if (!(width > 0) || !(height > 0)) return 0;

  const left = placement.centerX - width / 2;
  const top = placement.centerY - height / 2;
  const cellWidth = width / profile.maskSize;
  const cellHeight = height / profile.maskSize;

  // Cheap rejection: the content's own rect misses the region entirely.
  if (
    left >= region[2] ||
    top >= region[3] ||
    left + width <= region[0] ||
    top + height <= region[1]
  ) {
    return 0;
  }

  let total = 0;
  for (let row = 0; row < profile.maskSize; row += 1) {
    const cellTop = top + row * cellHeight;
    const cellBottom = cellTop + cellHeight;
    const overlapTop = Math.max(cellTop, region[1]);
    const overlapBottom = Math.min(cellBottom, region[3]);
    if (overlapBottom <= overlapTop) continue;

    for (let column = 0; column < profile.maskSize; column += 1) {
      const coverage = maskCoverage(profile, column, row);
      if (coverage <= 0) continue;
      const cellLeft = left + column * cellWidth;
      const overlapLeft = Math.max(cellLeft, region[0]);
      const overlapRight = Math.min(cellLeft + cellWidth, region[2]);
      if (overlapRight <= overlapLeft) continue;
      total += coverage * (overlapRight - overlapLeft) * (overlapBottom - overlapTop);
    }
  }
  return total;
}

/** Visible alpha area of the placed content, clipped to the canvas. */
export function visibleAlphaArea(
  profile: AlphaProfile,
  placement: ContentPlacement,
  canvas: CanvasSize,
): number {
  return alphaAreaWithin(profile, placement, [0, 0, canvas.width, canvas.height]);
}

/** Visible alpha area as a fraction of the whole canvas (the `hero_dominance` metric). */
export function canvasOccupancy(
  profile: AlphaProfile,
  placement: ContentPlacement,
  canvas: CanvasSize,
): number {
  const area = canvas.width * canvas.height;
  return area > 0 ? visibleAlphaArea(profile, placement, canvas) / area : 0;
}

/**
 * Fraction of `region` hidden by the placed content's alpha.
 *
 * Denominator is the region's own area, so a region hanging off the canvas counts
 * the off-canvas part as uncovered — conservative, which is the right direction
 * when the answer gates a "is the package still readable" decision.
 */
export function coveredFraction(
  profile: AlphaProfile,
  placement: ContentPlacement,
  region: Rect,
  canvas: CanvasSize,
): number {
  const area = rectArea(region);
  if (area <= 0) return 0;
  const clipped: Rect = [
    Math.max(region[0], 0),
    Math.max(region[1], 0),
    Math.min(region[2], canvas.width),
    Math.min(region[3], canvas.height),
  ];
  if (clipped[2] <= clipped[0] || clipped[3] <= clipped[1]) return 0;
  // Pass the CLIPPED rect: off-canvas parts of the region cannot be covered by
  // anything, and counting them would understate how hidden the box really is.
  return Math.min(1, alphaAreaWithin(profile, placement, clipped) / area);
}

/**
 * Convert a content placement into a Konva node placement.
 *
 * The layer model is centre-anchored over the FULL source image, so the trimmed
 * content's centre is offset from the image centre by
 * `(trimCentre - imageCentre) * scale`, and the node has to sit that much further
 * back. Missing this term is the classic bug: the geometry looks right, the
 * product is subtly too small and shifted toward a corner.
 */
export function toLayerPlacement(
  profile: AlphaProfile,
  placement: ContentPlacement,
): { x: number; y: number; scale: number } {
  const trimCenterX = profile.trim.left + profile.trim.width / 2;
  const trimCenterY = profile.trim.top + profile.trim.height / 2;
  const offsetX = (trimCenterX - profile.sourceWidth / 2) * placement.scale;
  const offsetY = (trimCenterY - profile.sourceHeight / 2) * placement.scale;
  return {
    x: placement.centerX - offsetX,
    y: placement.centerY - offsetY,
    scale: placement.scale,
  };
}

/** Inverse of `toLayerPlacement`, handy for assertions and for reading back a document. */
export function fromLayerPlacement(
  profile: AlphaProfile,
  layer: { x: number; y: number; scale: number },
): ContentPlacement {
  const trimCenterX = profile.trim.left + profile.trim.width / 2;
  const trimCenterY = profile.trim.top + profile.trim.height / 2;
  const offsetX = (trimCenterX - profile.sourceWidth / 2) * layer.scale;
  const offsetY = (trimCenterY - profile.sourceHeight / 2) * layer.scale;
  return { centerX: layer.x + offsetX, centerY: layer.y + offsetY, scale: layer.scale };
}
