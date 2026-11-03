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
 * Fraction of `back`'s OWN visible alpha that `front` actually covers.
 *
 * Three things this does that `coveredFraction()` cannot:
 *
 * 1. the denominator is the back layer's clipped **alpha** area (not a slot
 *    rectangle, which is bigger whenever the picture is letterboxed inside it —
 *    that made a fully hidden box report 75% visible);
 * 2. off-canvas parts are excluded, because nothing can be hidden where nothing
 *    can be seen;
 * 3. the numerator is a real alpha ∩ alpha intersection (10.22.2). Up to 10.22.1
 *    it was "front's alpha inside the back layer's bounding rectangle", which
 *    counts every front pixel over a *transparent* part of the box. The 2026-11-03
 *    re-check built the minimal counter-example: two 100×100 pictures on the same
 *    spot with disjoint 2×2 masks (`[1,0,0,1]` vs `[0,1,1,0]`) reported 100%
 *    occluded, because the rectangle test never looked at the box's own alpha.
 *
 * Both masks are sampled on a shared grid over the overlap rectangle; a sample
 * counts `min(frontCoverage, backCoverage)`, which is the area fraction where both
 * layers are opaque. Grid resolution is capped so a solver can still call this
 * hundreds of times per material.
 */
export function occlusionRatio(
  front: { profile: AlphaProfile; placement: ContentPlacement },
  back: { profile: AlphaProfile; placement: ContentPlacement },
  canvas: CanvasSize,
): number {
  const backArea = visibleAlphaArea(back.profile, back.placement, canvas);
  if (backArea <= 0) return 0;
  const backRect = contentRect(back.profile, back.placement);
  const frontRect = contentRect(front.profile, front.placement);
  const overlap: Rect = [
    Math.max(backRect[0], frontRect[0]),
    Math.max(backRect[1], frontRect[1]),
    Math.min(backRect[2], frontRect[2]),
    Math.min(backRect[3], frontRect[3]),
  ];
  const clipped = clipToCanvas(overlap, canvas);
  const area = rectArea(clipped);
  if (area <= 0) return 0;

  const covered = alphaIntersectionWithin(front, back, clipped);
  return Math.min(1, Math.max(0, covered / backArea));
}

/**
 * Alpha ∩ alpha inside `region`, accumulated over the **back** layer's own mask cells.
 *
 * Sampling on a fixed grid (the 10.22.2 version capped at 64×64) silently skipped
 * thin opaque columns: a 128-cell mask whose contents are single-column stripes lost
 * almost all of them, so a fully covered box was reported as 97% visible (2026-11-03
 * 复核 R3). Walking the back mask's own cells costs at most `maskSize²` lookups and
 * cannot miss a stripe narrower than the sampling step, because the step IS the mask.
 */
function alphaIntersectionWithin(
  front: { profile: AlphaProfile; placement: ContentPlacement },
  back: { profile: AlphaProfile; placement: ContentPlacement },
  region: Rect,
): number {
  const width = region[2] - region[0];
  const height = region[3] - region[1];
  if (!(width > 0) || !(height > 0)) return 0;

  const maskSize = back.profile.maskSize;
  const backRect = contentRect(back.profile, back.placement);
  const cellWidth = (backRect[2] - backRect[0]) / maskSize;
  const cellHeight = (backRect[3] - backRect[1]) / maskSize;
  const cellArea = cellWidth * cellHeight;
  if (!(cellArea > 0)) return 0;

  let total = 0;
  for (let row = 0; row < maskSize; row += 1) {
    const y = backRect[1] + (row + 0.5) * cellHeight;
    if (y < region[1] || y > region[3]) continue;
    for (let column = 0; column < maskSize; column += 1) {
      const x = backRect[0] + (column + 0.5) * cellWidth;
      if (x < region[0] || x > region[2]) continue;
      const backCoverage = maskCoverage(back.profile, column, row);
      if (backCoverage <= 0) continue;
      const frontCoverage = coverageAt(front.profile, front.placement, x, y);
      if (frontCoverage <= 0) continue;
      total += Math.min(frontCoverage, backCoverage) * cellArea;
    }
  }
  return total;
}

/** Mask coverage of a placed profile at one canvas-space point. */
function coverageAt(
  profile: AlphaProfile,
  placement: ContentPlacement,
  x: number,
  y: number,
): number {
  const { width, height } = contentExtent(profile, placement.scale);
  if (!(width > 0) || !(height > 0)) return 0;
  const left = placement.centerX - width / 2;
  const top = placement.centerY - height / 2;
  const column = Math.floor(((x - left) / width) * profile.maskSize);
  const row = Math.floor(((y - top) / height) * profile.maskSize);
  if (column < 0 || row < 0 || column >= profile.maskSize || row >= profile.maskSize) return 0;
  return maskCoverage(profile, column, row);
}


/**
 * How deep a placed picture reaches into `zone`, in logical px, plus the alpha
 * fraction of the zone it covers.
 *
 * Why depth and not just the covered fraction (10.22.2): a 20×2000 hero dropped
 * onto an 800×88 footer strip covers 1.45% of the zone's area, yet it cuts the
 * strip in half top-to-bottom. Judging by area alone silently accepted that. The
 * depth of the overlap says "how far in", which is what "别压到底栏" actually
 * means; the area fraction is kept for the message.
 */
export function zoneIntrusion(
  profile: AlphaProfile,
  placement: ContentPlacement,
  zone: Rect,
  canvas: CanvasSize,
): { depth: number; covered: number } {
  const covered = coveredFraction(profile, placement, zone, canvas);
  if (covered <= 0) return { depth: 0, covered: 0 };
  const rect = clipToCanvas(contentRect(profile, placement), canvas);
  const overlap: Rect = [
    Math.max(rect[0], zone[0]),
    Math.max(rect[1], zone[1]),
    Math.min(rect[2], zone[2]),
    Math.min(rect[3], zone[3]),
  ];
  if (overlap[2] <= overlap[0] || overlap[3] <= overlap[1]) return { depth: 0, covered };
  /*
    Depth must be measured ALONG the direction the zone blocks, not as the短边 of the
    overlap. Taking the short side meant a 10×2000 hero through an 800×88 footer
    reported `5.8px` (its own width) instead of the 88px it actually cuts through, and
    the 6px gate let it pass (2026-11-03 复核 R7). A zone is a band: its long edge says
    which axis is "into the zone", so the overlap's extent on the OTHER axis is the depth.
  */
  const overlapWidth = overlap[2] - overlap[0];
  const overlapHeight = overlap[3] - overlap[1];
  const zoneWidth = zone[2] - zone[0];
  const zoneHeight = zone[3] - zone[1];
  const depth = zoneWidth >= zoneHeight ? overlapHeight : overlapWidth;
  return { depth, covered };
}

/** `region` clipped to the canvas; empty when nothing of it is on screen. */
export function clipToCanvas(region: Rect, canvas: CanvasSize): Rect {  return [
    Math.max(region[0], 0),
    Math.max(region[1], 0),
    Math.min(region[2], canvas.width),
    Math.min(region[3], canvas.height),
  ];
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
