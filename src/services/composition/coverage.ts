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
 * Alpha ∩ alpha inside `region`, integrated exactly over the refinement of BOTH masks.
 *
 * Three earlier attempts sampled instead of integrating, and every one of them lost
 * content (2026-11-03 复核 R3, three rounds):
 *
 * - 10.22.2 used a fixed 64×64 grid → 128-column stripes were skipped;
 * - 10.22.3 walked the back mask's own cells → still missed a fine front mask behind a
 *   coarse back mask (0% for a true 50.8%);
 * - 10.22.4 integrated the refinement, but THINNED the edge list to 200 per axis once
 *   128+128 edges showed up. Dropping an edge merges two rectangles with different
 *   alpha into one, and the centre sample then stands for the average of the two:
 *   two 128-cell comb masks offset by half a pixel reported 73.55% visible instead of
 *   50.94% — 22.6 points, not an anti-aliasing detail.
 *
 * Both masks are piecewise constant on their own cell grid, so on the refinement of the
 * two grids `min(front, back)` is constant per rectangle and `Σ min(f,b) × area` is the
 * exact integral. The refinement needs **no budget**: `maskSize ≤ 128` (see
 * `alpha-scan.ts`), so an axis can never have more than 2 × 128 + 1 = 257 edges, i.e. at
 * most ~66k rectangles, and only the non-empty ones cost a lookup because cell indices
 * are precomputed per interval.
 */
function alphaIntersectionWithin(
  front: { profile: AlphaProfile; placement: ContentPlacement },
  back: { profile: AlphaProfile; placement: ContentPlacement },
  region: Rect,
): number {
  const xs = refinedAxis(front, back, region, 'x');
  const ys = refinedAxis(front, back, region, 'y');
  if (xs.edges.length < 2 || ys.edges.length < 2) return 0;

  let total = 0;
  for (let row = 0; row < ys.edges.length - 1; row += 1) {
    const height = ys.edges[row + 1] - ys.edges[row];
    if (!(height > 0)) continue;
    const frontRow = ys.frontCells[row];
    const backRow = ys.backCells[row];
    if (frontRow < 0 || backRow < 0) continue;
    for (let column = 0; column < xs.edges.length - 1; column += 1) {
      const width = xs.edges[column + 1] - xs.edges[column];
      if (!(width > 0)) continue;
      const backColumn = xs.backCells[column];
      if (backColumn < 0) continue;
      const backCoverage = maskCoverage(back.profile, backColumn, backRow);
      if (backCoverage <= 0) continue;
      const frontColumn = xs.frontCells[column];
      if (frontColumn < 0) continue;
      const frontCoverage = maskCoverage(front.profile, frontColumn, frontRow);
      if (frontCoverage <= 0) continue;
      total += Math.min(frontCoverage, backCoverage) * width * height;
    }
  }
  return total;
}

interface RefinedAxis {
  /** 区间边界，`edges[i]` 到 `edges[i + 1]` 是一个细化矩形带。 */
  edges: number[];
  /** 每个区间中心落在前景 / 后景的哪一格（-1 表示落在图外）。 */
  frontCells: number[];
  backCells: number[];
}

/** 两个掩码在某个轴上的全部格边（裁剪到 `region`）+ 每个区间的格号。 */
function refinedAxis(
  front: { profile: AlphaProfile; placement: ContentPlacement },
  back: { profile: AlphaProfile; placement: ContentPlacement },
  region: Rect,
  axis: 'x' | 'y',
): RefinedAxis {
  const from = axis === 'x' ? region[0] : region[1];
  const to = axis === 'x' ? region[2] : region[3];
  const edges: number[] = [from, to];
  const collect = (side: { profile: AlphaProfile; placement: ContentPlacement }) => {
    const rect = contentRect(side.profile, side.placement);
    const start = axis === 'x' ? rect[0] : rect[1];
    const end = axis === 'x' ? rect[2] : rect[3];
    const size = side.profile.maskSize;
    const step = (end - start) / size;
    if (!(step > 0)) return;
    for (let index = 1; index < size; index += 1) {
      const edge = start + index * step;
      if (edge > from && edge < to) edges.push(edge);
    }
  };
  collect(back);
  collect(front);
  edges.sort((left, right) => left - right);
  const unique: number[] = [];
  for (const edge of edges) {
    if (unique.length === 0 || edge - unique[unique.length - 1] > 1e-6) unique.push(edge);
  }

  const frontCells: number[] = [];
  const backCells: number[] = [];
  for (let index = 0; index < unique.length - 1; index += 1) {
    const middle = (unique[index] + unique[index + 1]) / 2;
    frontCells.push(cellIndex(front, middle, axis));
    backCells.push(cellIndex(back, middle, axis));
  }
  return { edges: unique, frontCells, backCells };
}

/** 画布坐标 `value` 落在该图层的哪一个掩码格里（图外返回 -1）。 */
function cellIndex(
  side: { profile: AlphaProfile; placement: ContentPlacement },
  value: number,
  axis: 'x' | 'y',
): number {
  const rect = contentRect(side.profile, side.placement);
  const start = axis === 'x' ? rect[0] : rect[1];
  const end = axis === 'x' ? rect[2] : rect[3];
  const span = end - start;
  if (!(span > 0)) return -1;
  const index = Math.floor(((value - start) / span) * side.profile.maskSize);
  if (index < 0 || index >= side.profile.maskSize) return -1;
  return index;
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
