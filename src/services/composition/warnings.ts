/**
 * Diagnostics for composition runs.
 *
 * Same shape as the page-fill warnings: a stable English `code` for tests and
 * logs, a Chinese `message` for the user, and optional structured `detail` so a
 * "why did it resize my hero" question can be answered from a log line instead
 * of a reproduction.
 *
 * A warning never blocks the output — the layout is still produced. The one thing
 * a warning must NOT do is stay silent about a compromise the solver made.
 */

export type CompositionWarningCode =
  /** Visible hero area landed under `min_canvas_occupancy`. */
  | 'hero_occupancy_below_min'
  /** Hero met the floor but missed the preferred band. */
  | 'hero_occupancy_outside_target'
  /** The solver had to move the template's nominal zoom. */
  | 'hero_zoom_reduced'
  | 'hero_zoom_raised'
  /** Every variant leaves less of the box visible than `min_visible_ratio`. */
  | 'box_visibility_below_min'
  /** No usable variant at all (bad template or unusable material). */
  | 'box_no_variant'
  /** The text zone could not hold the string even at the smallest font. */
  | 'text_does_not_fit'
  /** No role binding could be produced; the caller fell back to heuristics. */
  | 'role_binding_fallback'
  /** No material could fill the box slot, so a fallback was used. */
  | 'box_material_missing'
  /** A collage slot (`secondary` / `accent` with its own `closeup`) got no usable material. */
  | 'support_slot_empty';

export interface CompositionWarning {
  code: CompositionWarningCode;
  message: string;
  detail?: Record<string, unknown>;
}

export function warning(
  code: CompositionWarningCode,
  message: string,
  detail?: Record<string, unknown>,
): CompositionWarning {
  return detail ? { code, message, detail } : { code, message };
}

/** Fixed-precision number for log lines — keeps snapshots stable. */
export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
