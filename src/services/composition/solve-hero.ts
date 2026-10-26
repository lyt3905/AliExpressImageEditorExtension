/**
 * Hero (close-up) solver.
 *
 * The template gives a nominal `zoom` (2.2 in v1.4). Taken literally that is just
 * arithmetic — fit the content to the viewport, multiply, pin the top edge. But
 * `zoom 2.2` only lands in the declared occupancy band for products of a certain
 * proportion and alpha density; for a solid square product it puts ~77% of the
 * canvas under the hero, and for a thin one it never reaches the floor. So the
 * nominal zoom is a CEILING, not a target: the solver reduces it until
 * `hero_dominance` is satisfied, and never increases it (see `allowZoomRaise`).
 * Reducing crops less of the product; increasing would satisfy the metric by
 * cutting the product away, which is backwards for a 主图.
 *
 * Ranking, lexicographic:
 *   1. inside the preferred band        >  above the floor  >  below the floor
 *   2. distance from the nominal zoom   (or, when below the floor: higher occupancy)
 *   3. the smaller zoom                 (less overflow, more source visible)
 *
 * Why a dense scan instead of a binary search: occupancy is NOT monotonic in zoom.
 * The horizontal anchor sits at `center_x` (300) while the canvas centre is 400, so
 * as content grows its left half starts leaving the canvas while its right half is
 * still growing. A bisection can happily converge onto the wrong branch. 60 coarse
 * samples plus a refined bracket cost well under a millisecond each and make no
 * assumptions about the curve.
 */

import type { AlphaProfile } from './alpha';
import { canvasOccupancy, contentRect, type CanvasSize, type ContentPlacement } from './coverage';
import { round, warning, type CompositionWarning } from './warnings';
import type { CloseupSpec, HeroDominanceRule } from './types';

export interface HeroSolveRequest {
  profile: AlphaProfile;
  closeup: CloseupSpec;
  canvas: CanvasSize;
  dominance: HeroDominanceRule;
  /** Zoom search bounds. 1 = exactly the fitted size. */
  minZoom?: number;
  maxZoom?: number;
  /**
   * Allow zooming PAST the template's nominal value.
   *
   * Off by default, and the default matters: the nominal zoom is the most
   * aggressive crop the template author was willing to accept. Raising it to hit
   * an occupancy number means cutting more of the product away to satisfy a
   * metric — the subject "fills more of the frame" because less of it is shown.
   * For a 主图 that is the wrong trade: recognisability beats a percentage. So a
   * sparse product keeps the authored zoom and gets a warning instead.
   */
  allowZoomRaise?: boolean;
  /** Coarse sample count across the range. */
  samples?: number;
  /** Extra samples inside the bracket around the coarse winner. */
  refineSamples?: number;
  /** Relative zoom change that counts as "the solver moved it", default 0.15. */
  zoomTolerance?: number;
}

export interface HeroSolution {
  zoom: number;
  placement: ContentPlacement;
  /** Visible alpha area / canvas area at the chosen zoom. */
  occupancy: number;
  warnings: CompositionWarning[];
}

const DEFAULT_MIN_ZOOM = 1;
const DEFAULT_MAX_ZOOM = 4;
const DEFAULT_SAMPLES = 60;
const DEFAULT_REFINE_SAMPLES = 40;

/** Placement for a given zoom: `fit` first, then zoom, then the top-centre anchor. */
export function heroPlacement(
  profile: AlphaProfile,
  closeup: CloseupSpec,
  zoom: number,
): ContentPlacement {
  const viewportWidth = closeup.viewport[2] - closeup.viewport[0];
  const viewportHeight = closeup.viewport[3] - closeup.viewport[1];
  const fitScale =
    closeup.fit === 'height' ? viewportHeight / profile.trim.height : viewportWidth / profile.trim.width;
  const scale = fitScale * zoom;

  // The anchor is what keeps the close-up from drifting: the content's TOP edge is
  // pinned to the viewport top, so growing the zoom crops further down the product
  // instead of pushing its head up into the text zone.
  const height = profile.trim.height * scale;
  return {
    centerX: closeup.centerX,
    centerY: closeup.viewport[1] + height / 2,
    scale,
  };
}

interface Candidate {
  zoom: number;
  placement: ContentPlacement;
  occupancy: number;
}

function compareCandidates(a: Candidate, b: Candidate, context: {
  band: [number, number];
  floor: number;
  nominal: number;
}): number {
  const tier = (candidate: Candidate): number =>
    candidate.occupancy >= context.band[0] && candidate.occupancy <= context.band[1]
      ? 0
      : candidate.occupancy >= context.floor
        ? 1
        : 2;

  const tierA = tier(a);
  const tierB = tier(b);
  if (tierA !== tierB) return tierA - tierB;

  // Below the floor there is no "good" choice: take as much subject as possible.
  if (tierA === 2) {
    if (a.occupancy !== b.occupancy) return b.occupancy - a.occupancy;
    return a.zoom - b.zoom;
  }

  const deviationA = Math.abs(a.zoom - context.nominal);
  const deviationB = Math.abs(b.zoom - context.nominal);
  if (deviationA !== deviationB) return deviationA - deviationB;
  return a.zoom - b.zoom;
}

function sampleRange(from: number, to: number, count: number): number[] {
  if (count <= 1 || from === to) return [from];
  const step = (to - from) / (count - 1);
  return Array.from({ length: count }, (_unused, index) => from + index * step);
}

export function solveHero(request: HeroSolveRequest): HeroSolution {
  const {
    profile,
    closeup,
    canvas,
    dominance,
    minZoom = DEFAULT_MIN_ZOOM,
    maxZoom = DEFAULT_MAX_ZOOM,
    samples = DEFAULT_SAMPLES,
    refineSamples = DEFAULT_REFINE_SAMPLES,
    zoomTolerance = 0.15,
    allowZoomRaise = false,
  } = request;

  const band: [number, number] = dominance.targetCanvasOccupancy;
  const context = { band, floor: dominance.minCanvasOccupancy, nominal: closeup.zoom };

  // The nominal zoom is the ceiling unless the caller explicitly opts out of that
  // rule; see `allowZoomRaise`.
  const upperZoom = allowZoomRaise ? maxZoom : Math.min(maxZoom, closeup.zoom);
  const lowerZoom = Math.min(minZoom, upperZoom);

  const evaluate = (zoom: number): Candidate => {
    const placement = heroPlacement(profile, closeup, zoom);
    return { zoom, placement, occupancy: canvasOccupancy(profile, placement, canvas) };
  };

  const coarse = sampleRange(lowerZoom, upperZoom, samples).map(evaluate);
  let best = coarse.reduce((winner, candidate) =>
    compareCandidates(candidate, winner, context) < 0 ? candidate : winner,
  );

  // Refine inside the bracket around the coarse winner. The union is re-ranked with
  // the same comparator, so refinement can never make the answer worse.
  const step = samples > 1 ? (upperZoom - lowerZoom) / (samples - 1) : 0;
  if (step > 0) {
    const from = Math.max(lowerZoom, best.zoom - step);
    const to = Math.min(upperZoom, best.zoom + step);
    const refined = sampleRange(from, to, refineSamples).map(evaluate);
    best = refined.reduce(
      (winner, candidate) => (compareCandidates(candidate, winner, context) < 0 ? candidate : winner),
      best,
    );
  }

  const warnings: CompositionWarning[] = [];
  if (best.occupancy < dominance.minCanvasOccupancy) {
    warnings.push(
      warning(
        'hero_occupancy_below_min',
        `主体可见占比只有 ${round(best.occupancy * 100, 1)}%，低于要求的 ${round(dominance.minCanvasOccupancy * 100, 1)}%（素材自身透明太多或太细）`,
        { occupancy: round(best.occupancy), floor: dominance.minCanvasOccupancy, zoom: round(best.zoom) },
      ),
    );
  } else if (best.occupancy < band[0] || best.occupancy > band[1]) {
    warnings.push(
      warning(
        'hero_occupancy_outside_target',
        `主体可见占比 ${round(best.occupancy * 100, 1)}%，落在目标区间 ${round(band[0] * 100)}–${round(band[1] * 100)}% 之外（已满足下限，不再强求）`,
        { occupancy: round(best.occupancy), band },
      ),
    );
  }

  const deviation = Math.abs(best.zoom - closeup.zoom) / closeup.zoom;
  if (deviation > zoomTolerance) {
    const lower = best.zoom < closeup.zoom;
    warnings.push(
      warning(
        lower ? 'hero_zoom_reduced' : 'hero_zoom_raised',
        `模板名义 zoom ${closeup.zoom} 会把主体占比推到 ${round(best.occupancy * 100, 1)}% 附近，已调整为 ${round(best.zoom, 2)}（${lower ? '缩小' : '放大'} ${round(deviation * 100)}%）`,
        { nominal: closeup.zoom, chosen: round(best.zoom, 2), deviation: round(deviation) },
      ),
    );
  }

  return { zoom: best.zoom, placement: best.placement, occupancy: best.occupancy, warnings };
}

/** `[l,t,r,b]` of the trimmed content at the solution — used by tests and diagnostics. */
export function solvedContentRect(profile: AlphaProfile, solution: HeroSolution): [number, number, number, number] {
  return contentRect(profile, solution.placement);
}
