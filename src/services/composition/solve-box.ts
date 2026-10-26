/**
 * Package-box solver (the `box` role slot).
 *
 * The template ships four near-identical variants (a few pixels apart). That is
 * not decoration: which one works depends on the product, because the hero is
 * deliberately allowed to overlap this slot. The solver therefore scores every
 * variant by how much of the box stays visible and takes the best one.
 *
 * Determinism matters more than variety here. Ties are broken by a hash of the
 * product code, so regenerating the same product produces the same image (a
 * reviewer can reproduce it, and a diff of two runs is empty) while two different
 * products still land on different variants — which is the point of having four in
 * the first place.
 */

import type { AlphaProfile } from './alpha';
import { coveredFraction, type CanvasSize, type ContentPlacement } from './coverage';
import { rectFromCenter, rectArea } from './rect';
import { round, warning, type CompositionWarning } from './warnings';
import type { BoxVariant, Rect } from './types';

export interface HeroSilhouette {
  profile: AlphaProfile;
  placement: ContentPlacement;
}

export interface BoxSolveRequest {
  profile: AlphaProfile;
  variants: BoxVariant[];
  canvas: CanvasSize;
  /** Minimum share of the box's own alpha that must stay visible. */
  minVisibleRatio: number;
  /** The hero as actually placed — this is what may hide the box. */
  hero?: HeroSilhouette | null;
  /** Deterministic tie-break seed; product code by convention. */
  seed?: string;
  /** Never blow a small package photo up beyond this. */
  maxUpscale?: number;
}

export interface BoxCandidate {
  variantIndex: number;
  rect: Rect;
  placement: ContentPlacement;
  /** 1 = fully visible, 0 = completely behind the hero. */
  visibleRatio: number;
}

export interface BoxSolution extends BoxCandidate {
  candidates: BoxCandidate[];
  warnings: CompositionWarning[];
}

const DEFAULT_MAX_UPSCALE = 2;

/** FNV-1a 32-bit — small, dependency-free, stable across runs. */
export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function solveBox(request: BoxSolveRequest): BoxSolution | null {
  const { profile, variants, canvas, minVisibleRatio, hero, seed = '', maxUpscale = DEFAULT_MAX_UPSCALE } = request;

  if (variants.length === 0) {
    return null;
  }

  const candidates = variants
    .map((variant, index): BoxCandidate | null => {
      const rect = rectFromCenter(variant.center, variant.maxSize);
      if (rectArea(rect) <= 0) return null;

      // `contain`, never stretch: the box's silhouette must keep its proportions.
      const fitScale = Math.min(
        variant.maxSize[0] / profile.trim.width,
        variant.maxSize[1] / profile.trim.height,
      );
      const scale = Math.min(fitScale, maxUpscale);
      if (!(scale > 0)) return null;

      const placement: ContentPlacement = {
        centerX: variant.center[0],
        centerY: variant.center[1],
        scale,
      };
      const hidden = hero ? coveredFraction(hero.profile, hero.placement, rect, canvas) : 0;
      return {
        variantIndex: index,
        rect,
        placement,
        visibleRatio: Math.min(1, Math.max(0, 1 - hidden)),
      };
    })
    .filter((candidate): candidate is BoxCandidate => candidate !== null);

  if (candidates.length === 0) return null;

  const winner = candidates.reduce((best, candidate) => {
    const diff = candidate.visibleRatio - best.visibleRatio;
    // 1e-6 tolerance: variants a few pixels apart differ by far less than that in
    // coverage terms, and without it float noise alone would pick the winner.
    if (Math.abs(diff) > 1e-6) return diff > 0 ? candidate : best;
    return stableHash(`${seed}:${candidate.variantIndex}`) < stableHash(`${seed}:${best.variantIndex}`)
      ? candidate
      : best;
  });

  const warnings: CompositionWarning[] = [];
  if (winner.visibleRatio < minVisibleRatio) {
    warnings.push(
      warning(
        'box_visibility_below_min',
        `包装盒可见比例只有 ${round(winner.visibleRatio * 100, 1)}%，低于要求的 ${round(minVisibleRatio * 100, 1)}%（主体挡住了它）`,
        {
          visibleRatio: round(winner.visibleRatio),
          threshold: minVisibleRatio,
          variantIndex: winner.variantIndex,
        },
      ),
    );
  }

  return { ...winner, candidates, warnings };
}
