/**
 * Picture effects: parse, clamp and normalise the per-layer `effects` block.
 *
 * Everything here is pure — no Konva, no DOM — because three very different
 * callers need the same answers: the reducer (does this patch make sense?),
 * the panel (what do I show in the sliders?) and the stage (what do I paint?).
 * The stage still owns the Konva-specific translation (`filters`, `cache()`);
 * this module only produces numbers a painter can trust.
 */

import { DEFAULT_IMAGE_EFFECTS, IMAGE_EFFECT_LIMITS } from '../shared/constants';
import type { ImageEffects } from '../shared/types';

/** Fallback for both "no effects" and "the stored value was junk". */
export const EMPTY_IMAGE_EFFECTS: ImageEffects = DEFAULT_IMAGE_EFFECTS;

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readNumber(raw: unknown, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return clamp(raw, min, max);
}

/** `#abc` → `#aabbcc`; anything that is not a hex colour falls back. */
export function normalizeColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!HEX_COLOR.test(trimmed)) return fallback;
  if (trimmed.length === 4) {
    const [r, g, b] = trimmed.slice(1);
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return trimmed.toLowerCase();
}

/**
 * Coerce anything into a complete block.
 *
 * Called on the way in (a patch from the panel) and on the way out (a document
 * restored from storage) precisely because a half-filled block is worse than no
 * block: `opacity: undefined` paints fully transparent in Konva, so a corrupt
 * field would silently erase a layer instead of being ignored.
 */
export function normalizeImageEffects(raw: unknown): ImageEffects {
  if (typeof raw !== 'object' || raw === null) return { ...EMPTY_IMAGE_EFFECTS };
  const value = raw as Record<string, unknown>;
  return {
    opacity: readNumber(value.opacity, EMPTY_IMAGE_EFFECTS.opacity, 0, 1),
    brightness: readNumber(value.brightness, EMPTY_IMAGE_EFFECTS.brightness, -1, 1),
    grayscale: value.grayscale === true,
    shadowColor: normalizeColor(value.shadowColor, EMPTY_IMAGE_EFFECTS.shadowColor),
    shadowBlur: readNumber(value.shadowBlur, 0, 0, IMAGE_EFFECT_LIMITS.shadowBlur),
    shadowOpacity: readNumber(value.shadowOpacity, 0, 0, 1),
    shadowOffsetX: readNumber(
      value.shadowOffsetX,
      0,
      -IMAGE_EFFECT_LIMITS.shadowOffset,
      IMAGE_EFFECT_LIMITS.shadowOffset,
    ),
    shadowOffsetY: readNumber(
      value.shadowOffsetY,
      0,
      -IMAGE_EFFECT_LIMITS.shadowOffset,
      IMAGE_EFFECT_LIMITS.shadowOffset,
    ),
    glowColor: normalizeColor(value.glowColor, EMPTY_IMAGE_EFFECTS.glowColor),
    glowRadius: readNumber(value.glowRadius, 0, 0, IMAGE_EFFECT_LIMITS.glowRadius),
    glowBlur: readNumber(value.glowBlur, 0, 0, IMAGE_EFFECT_LIMITS.glowBlur),
    glowOpacity: readNumber(value.glowOpacity, 0, 0, 1),
  };
}

/** True when `raw` carries at least one effect worth a cache + a second node. */
export function hasVisibleEffects(raw: unknown): boolean {
  const effects = normalizeImageEffects(raw);
  return (
    effects.opacity < 1 ||
    effects.brightness !== 0 ||
    effects.grayscale ||
    (effects.shadowOpacity > 0 && (effects.shadowBlur > 0 || effects.shadowOffsetX !== 0 || effects.shadowOffsetY !== 0)) ||
    (effects.glowOpacity > 0 && (effects.glowRadius > 0 || effects.glowBlur > 0))
  );
}

/** True when the picture needs a pixel filter pass (and therefore `cache()`). */
export function needsFilterPass(raw: unknown): boolean {
  const effects = normalizeImageEffects(raw);
  return effects.grayscale || effects.brightness !== 0;
}

/**
 * True when `raw` ALREADY holds exactly the legacy-safe shape and values.
 *
 * `imageEffectsEqual()` cannot answer this: it normalises both sides, so a
 * stored `opacity: 12` and a repaired `opacity: 1` look equal — which is exactly
 * the bug that made a restored out-of-range block keep its value. Comparing the
 * raw fields against the normalised ones is the only honest test.
 */
export function isNormalizedEffects(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const value = raw as Record<string, unknown>;
  const normalized = normalizeImageEffects(value) as unknown as Record<string, unknown>;
  const keys = Object.keys(normalized);
  if (Object.keys(value).length !== keys.length) return false;
  return keys.every((key) => value[key] === normalized[key]);
}

export function imageEffectsEqual(left: unknown, right: unknown): boolean {  const a = normalizeImageEffects(left);
  const b = normalizeImageEffects(right);
  return (
    a.opacity === b.opacity &&
    a.brightness === b.brightness &&
    a.grayscale === b.grayscale &&
    a.shadowColor === b.shadowColor &&
    a.shadowBlur === b.shadowBlur &&
    a.shadowOpacity === b.shadowOpacity &&
    a.shadowOffsetX === b.shadowOffsetX &&
    a.shadowOffsetY === b.shadowOffsetY &&
    a.glowColor === b.glowColor &&
    a.glowRadius === b.glowRadius &&
    a.glowBlur === b.glowBlur &&
    a.glowOpacity === b.glowOpacity
  );
}

/** `#rrggbb` → 0–255 triple, for Konva's `Filters.RGB` channel multipliers. */
export function colorChannels(color: string): { red: number; green: number; blue: number } {
  const hex = normalizeColor(color, '#000000');
  return {
    red: parseInt(hex.slice(1, 3), 16),
    green: parseInt(hex.slice(3, 5), 16),
    blue: parseInt(hex.slice(5, 7), 16),
  };
}

/**
 * Compose the shadow colour with its opacity.
 *
 * Konva has `shadowColor` but no `shadowOpacity` (the text layer keeps a
 * separate field only because the panel needed a 0–100 slider). Folding the
 * alpha into the colour is the only way one picture node can carry a shadow
 * without a second draw call.
 */
export function shadowColorWithOpacity(color: string, opacity: number): string {
  const hex = normalizeColor(color, EMPTY_IMAGE_EFFECTS.shadowColor);
  const alpha = clamp(Number.isFinite(opacity) ? opacity : 0, 0, 1);
  const red = parseInt(hex.slice(1, 3), 16);
  const green = parseInt(hex.slice(3, 5), 16);
  const blue = parseInt(hex.slice(5, 7), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
