/**
 * Text style: the part of a text layer that is worth remembering.
 *
 * A new text layer starts from the last used style (font, size, colour,
 * outline, shadow) but never from the previous copy, position or transform —
 * the authoritative field list is `TEXT_STYLE_KEYS` in constants.ts.
 *
 * Lives in `shared/` on purpose: both `editor/state` (restore + create) and
 * `services` (the preference store) need it, and `services` must not reach
 * into `editor/`.
 */

import {
  MAX_FONT_SIZE,
  MAX_SHADOW_BLUR,
  MAX_SHADOW_OFFSET,
  MAX_STROKE_WIDTH,
  MIN_FONT_SIZE,
  MIN_SHADOW_BLUR,
  MIN_SHADOW_OFFSET,
  MIN_STROKE_WIDTH,
  TEXT_LAYER_DEFAULTS,
  TEXT_STYLE_KEYS,
} from './constants';
import type { LayerPatch, TextLayer } from './types';

/** The style fields of a text layer — exactly the keys listed in `TEXT_STYLE_KEYS`. */
export type TextStyleDefaults = Pick<TextLayer, (typeof TEXT_STYLE_KEYS)[number]>;

/** Loosely-typed view used for key-driven reads of untrusted JSON. */
type AnyRecord = Record<string, unknown>;

// ---------------------------------------------------------------- primitives

/*
 * Shared with `editor-reducer.ts` so "how a number / colour is coerced" has
 * exactly one implementation for both stored documents and stored preferences.
 */

export function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Coerce a number into range.
 *
 * Out-of-range values reach the canvas as-is otherwise, and Konva renders a
 * negative `strokeWidth` or a 40x `shadowOpacity` in ways nobody asked for.
 */
export function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = finiteNumber(value, fallback);
  return Math.min(max, Math.max(min, parsed));
}

export function pickColor(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value : fallback;
}

export function pickAlign(value: unknown, fallback: TextLayer['align']): TextLayer['align'] {
  return value === 'left' || value === 'right' || value === 'center' ? value : fallback;
}

export function pickFontStyle(value: unknown, fallback: TextLayer['fontStyle']): TextLayer['fontStyle'] {
  return value === 'bold' || value === 'normal' ? value : fallback;
}

// ---------------------------------------------------------------- style object

/**
 * Factory defaults restricted to the remembered keys.
 *
 * Derived rather than written out, so adding a field to `TEXT_STYLE_KEYS`
 * cannot silently leave the default behind.
 */
export const DEFAULT_TEXT_STYLE: TextStyleDefaults = Object.freeze(
  Object.fromEntries(
    TEXT_STYLE_KEYS.map((key) => [key, TEXT_LAYER_DEFAULTS[key]]),
  ) as TextStyleDefaults,
);

/**
 * Rebuild a complete, in-range style from untrusted JSON, field by field.
 *
 * Runs on every read *and* every write, so a hand-edited or corrupted storage
 * entry can never put a 99999px font on the canvas.
 */
export function sanitizeTextStyle(
  raw: unknown,
  fallback: TextStyleDefaults = DEFAULT_TEXT_STYLE,
): TextStyleDefaults {
  const source = (raw && typeof raw === 'object' ? raw : {}) as AnyRecord;
  return {
    fontSize: clampNumber(source.fontSize, fallback.fontSize, MIN_FONT_SIZE, MAX_FONT_SIZE),
    fontFamily: pickColor(source.fontFamily, fallback.fontFamily),
    fill: pickColor(source.fill, fallback.fill),
    fontStyle: pickFontStyle(source.fontStyle, fallback.fontStyle),
    align: pickAlign(source.align, fallback.align),
    stroke: pickColor(source.stroke, fallback.stroke),
    strokeWidth: clampNumber(
      source.strokeWidth,
      fallback.strokeWidth,
      MIN_STROKE_WIDTH,
      MAX_STROKE_WIDTH,
    ),
    shadowColor: pickColor(source.shadowColor, fallback.shadowColor),
    shadowBlur: clampNumber(source.shadowBlur, fallback.shadowBlur, MIN_SHADOW_BLUR, MAX_SHADOW_BLUR),
    shadowOffsetX: clampNumber(
      source.shadowOffsetX,
      fallback.shadowOffsetX,
      MIN_SHADOW_OFFSET,
      MAX_SHADOW_OFFSET,
    ),
    shadowOffsetY: clampNumber(
      source.shadowOffsetY,
      fallback.shadowOffsetY,
      MIN_SHADOW_OFFSET,
      MAX_SHADOW_OFFSET,
    ),
    // Konva's unit: 0–1, not a percentage.
    shadowOpacity: clampNumber(source.shadowOpacity, fallback.shadowOpacity, 0, 1),
  };
}

/**
 * Extract the style fields a patch carries, or `null` when it carries none.
 *
 * The `null` is the point: dragging a layer or retyping its copy must not
 * trigger a storage write.
 */
export function pickTextStyle(patch: LayerPatch): Partial<TextStyleDefaults> | null {
  const source = patch as unknown as AnyRecord;
  const picked: AnyRecord = {};
  for (const key of TEXT_STYLE_KEYS) {
    if (source[key] !== undefined) picked[key] = source[key];
  }
  return Object.keys(picked).length > 0 ? (picked as Partial<TextStyleDefaults>) : null;
}
