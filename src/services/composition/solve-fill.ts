/**
 * Turn a "this picture should take about 30% of the canvas" hint into geometry.
 *
 * The vision model answers WHICH photo goes where. It cannot answer where the
 * pixels land — but it can judge how large each figure should read ("the action
 * pose is the subject, the back view is scenery" is a composition decision, not a
 * measurement). So the model returns a target occupancy and this solver turns it
 * into a zoom, deterministically: the same answer always produces the same picture.
 *
 * Occupancy is visible alpha area / canvas area — the same metric `hero_dominance`
 * uses, so "30%" means the same thing in a template rule and in a model answer.
 */

import type { AlphaProfile } from './alpha';
import { canvasOccupancy, type CanvasSize, type ContentPlacement } from './coverage';
import { heroPlacement } from './solve-hero';
import type { CloseupSpec } from './types';

/**
 * How far the solver may move away from the template's authored zoom.
 *
 * Wide enough to turn "these three figures are all the same size" into a readable
 * collage, narrow enough that a wild number cannot push a figure off the canvas.
 */
const MIN_ZOOM_FACTOR = 0.45;
const MAX_ZOOM_FACTOR = 2.2;

/**
 * How far below the authored zoom a hint may push the content.
 *
 * Exported because the hero path needs the same floor: `solveHero` refuses to search
 * below zoom 1 (the fitted size) — right for a 主图 whose subject should fill the
 * frame, wrong when the model explicitly asked for a smaller figure in a collage.
 */
export const FILL_MIN_ZOOM_FACTOR = MIN_ZOOM_FACTOR;

/** Exported for the same reason in the other direction: the global fill pass must not exceed it. */
export const FILL_MAX_ZOOM_FACTOR = MAX_ZOOM_FACTOR;

/** Bisection steps. The sample is monotone in zoom, so ~22 steps land inside 0.1 %. */
const BISECTION_STEPS = 22;

/** Achieved-vs-target gap that still counts as "the solver hit it". */
const TOLERANCE = 0.02;

/** Occupancy targets outside this range are clamped: 5 % is a speck, 85 % is a backdrop. */
export const FILL_MIN = 0.05;
export const FILL_MAX = 0.85;

export interface SupportFillRequest {
  profile: AlphaProfile;
  closeup: CloseupSpec;
  canvas: CanvasSize;
  /** Target visible occupancy (0-1): fraction of the canvas the content should cover. */
  target: number;
}

export interface SupportFillSolution {
  zoom: number;
  placement: ContentPlacement;
  /** Occupancy actually achieved at this zoom. */
  occupancy: number;
  /** True when a zoom bound stopped the solver short of the target. */
  clamped: boolean;
}

export function solveSupportFill(request: SupportFillRequest): SupportFillSolution {
  const { profile, closeup, canvas } = request;
  const target = Math.min(FILL_MAX, Math.max(FILL_MIN, request.target));
  const nominal = closeup.zoom;
  const low = nominal * MIN_ZOOM_FACTOR;
  const high = nominal * MAX_ZOOM_FACTOR;

  const at = (zoom: number): { zoom: number; placement: ContentPlacement; occupancy: number } => {
    const placement = heroPlacement(profile, closeup, zoom);
    return { zoom, placement, occupancy: canvasOccupancy(profile, placement, canvas) };
  };

  const floor = at(low);
  const ceiling = at(high);

  /*
    Occupancy never shrinks as the zoom grows (the content only ever covers more),
    so a target outside the reachable range has no solution and the nearer bound
    wins. Saying so explicitly beats letting the bisection "converge" onto an edge
    and reporting success.
  */
  if (target <= floor.occupancy) {
    return { ...floor, clamped: floor.occupancy - target > TOLERANCE };
  }
  if (target >= ceiling.occupancy) {
    return { ...ceiling, clamped: Math.abs(ceiling.occupancy - target) > TOLERANCE };
  }

  let lower = low;
  let upper = high;
  let best = ceiling;

  for (let step = 0; step < BISECTION_STEPS; step += 1) {
    const middle = (lower + upper) / 2;
    const sample = at(middle);
    if (Math.abs(sample.occupancy - target) < Math.abs(best.occupancy - target)) best = sample;
    if (sample.occupancy < target) lower = middle;
    else upper = middle;
  }

  return { ...best, clamped: Math.abs(best.occupancy - target) > TOLERANCE };
}
