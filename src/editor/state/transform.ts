/**
 * Mirror / rotate / resize maths for the selected layer.
 *
 * Pure on purpose: the 90° buttons, the knob, the transformer's `transformend`
 * and the restore path all funnel through here, so "how an angle wraps", "how a
 * signed scale becomes a mirror flag" and "how a resize becomes a font size"
 * each have exactly one answer — and each is pinned by a test.
 *
 * The document stores a mirror as a boolean beside a positive `scale`, never as
 * a negative scale: Konva's transformer decomposes a resize back into a signed
 * scale, so a negative magnitude in the document would leak into the layer
 * panel's own readouts.
 */

import {
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  ROTATE_SNAP_DEG,
  ROTATE_STEP_DEG,
  TEXT_LAYER_DEFAULTS,
} from '../../shared/constants';
import type { BaseLayer, LayerPatch } from '../../shared/types';

/** The one-step transforms the buttons offer. */
export type TransformCommand = 'rotate-cw' | 'rotate-ccw' | 'flip-x' | 'flip-y';

/** Any angle, wrapped into [0, 360). */
export function normalizeRotation(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/**
 * The signed step from one angle to the next, in (-180, 180].
 *
 * A knob drag accumulates these rather than subtracting absolute angles: past
 * ±180° a raw difference flips sign and the layer would jump a whole turn.
 */
export function shortestDelta(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  const wrapped = degrees % 360;
  if (wrapped > 180) return wrapped - 360;
  if (wrapped <= -180) return wrapped + 360;
  return wrapped;
}

/** Nearest multiple of `step`, wrapped back into [0, 360). */
export function snapRotation(degrees: number, step: number = ROTATE_SNAP_DEG): number {
  if (!Number.isFinite(step) || step <= 0) return normalizeRotation(degrees);
  return normalizeRotation(Math.round(degrees / step) * step);
}

/**
 * The patch a 左转 / 右转 / 镜像 press produces, read against the layer's
 * current state.
 *
 * A 90° turn ADDS to whatever angle the layer already has (a layer dragged to
 * 30° becomes 120°), and the mirror flags simply toggle — neither is a
 * "set to a fixed value" operation.
 */
export function transformPatch(
  layer: Pick<BaseLayer, 'rotation' | 'flipX' | 'flipY'>,
  command: TransformCommand,
): LayerPatch {
  switch (command) {
    case 'rotate-cw':
      return { rotation: normalizeRotation(layer.rotation + ROTATE_STEP_DEG) };
    case 'rotate-ccw':
      return { rotation: normalizeRotation(layer.rotation - ROTATE_STEP_DEG) };
    case 'flip-x':
      return { flipX: layer.flipX !== true };
    case 'flip-y':
      return { flipY: layer.flipY !== true };
  }
}

/**
 * Wrap a knob angle into the patch to commit, or `null` when the layer already
 * sits at that angle.
 *
 * The `null` is load-bearing: `COMMIT_LAYER` always builds a new document, so a
 * commit that changes nothing still pushes an undo step which then visibly does
 * nothing. Clicking the knob without dragging, or double-clicking it when it is
 * already at 0°, must not cost the user an undo.
 */
export function rotationCommit(layer: Pick<BaseLayer, 'rotation'>, next: number): LayerPatch | null {
  const wrapped = normalizeRotation(next);
  return normalizeRotation(layer.rotation) === wrapped ? null : { rotation: wrapped };
}

/** The subset of a layer that decides how it is drawn on one axis. */
export interface ScaleFields {
  scale: number;
  flipX?: boolean;
  flipY?: boolean;
}

/** `scale` with the mirror sign applied, for one axis. */
export function axisScale(layer: ScaleFields, axis: 'x' | 'y'): number {
  const mirrored = axis === 'x' ? layer.flipX === true : layer.flipY === true;
  return mirrored ? -layer.scale : layer.scale;
}

/**
 * Split a Konva node's signed scale back into a magnitude plus mirror flags.
 *
 * The transformer hands back whatever the node ended up with, sign included —
 * a mirrored node stays mirrored through a resize — while the document keeps
 * the two parts apart.
 */
export function splitSignedScale(
  scaleX: number,
  scaleY: number,
): { scale: number; flipX: boolean; flipY: boolean } {
  const magnitude = Math.abs(scaleX) || Math.abs(scaleY);
  return {
    scale: magnitude > 0 ? magnitude : 1,
    flipX: scaleX < 0,
    flipY: scaleY < 0,
  };
}

/** A font size the panel can show, plus the part of the resize it could not hold. */
export interface BakedTextSize {
  fontSize: number;
  scale: number;
}

/**
 * Fold a text layer's resize back into its font size.
 *
 * A transformer drag only moves `scale`, so without this the 字号 field keeps
 * reading "48" while the text on screen is three times that — and the next new
 * layer, which inherits the style but never the transform, comes back small.
 * Baking makes the number in the field the size you actually see, and it rides
 * the existing style memory for free: the committed patch carries `fontSize`,
 * which is exactly what `pickTextStyle` remembers.
 *
 * Purely cosmetic for the current layer: `fontSize × scale` is preserved, so the
 * text does not move or change size at the moment of the drag's release.
 *
 * The font size is clamped to the panel's range (12–200), so a resize past the
 * limit keeps the leftover as `scale` rather than silently shrinking the text
 * back. Only the clamped part is remembered — 200px on an 800px canvas is
 * already most of the height.
 */
export function bakeTextScale(fontSize: number, scale: number): BakedTextSize {
  const current =
    Number.isFinite(fontSize) && fontSize > 0 ? fontSize : TEXT_LAYER_DEFAULTS.fontSize;
  const factor = Number.isFinite(scale) && scale > 0 ? scale : 1;

  // Guards a multiplication that overflowed: an infinite `scale` reaching the
  // document would be unrecoverable on the canvas.
  const product = current * factor;
  const target = Number.isFinite(product) && product > 0 ? product : MAX_FONT_SIZE;

  // The size the drag asked for, expressed as a font size the panel can show.
  const baked = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(target)));
  // Six decimals is far past anything a canvas can resolve, and it keeps the
  // stored document free of 0.10000000000000002-shaped leftovers.
  const rest = Math.round((target / baked) * 1e6) / 1e6;

  // `baked` is rounded, so an in-range resize lands within half a pixel of
  // scale 1 — snap it rather than leaving a 1.004 behind on every layer.
  return { fontSize: baked, scale: Math.abs(rest - 1) < 0.01 ? 1 : rest };
}
