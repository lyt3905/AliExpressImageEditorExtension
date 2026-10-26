/**
 * Layout templates: the declarative half of「AI 作图」.
 *
 * A template says WHERE things go and WHICH constraints hold; it never renders
 * anything. `template-schema.ts` turns the raw JSON into this shape (and rejects
 * the ambiguous / unsupported parts), the solvers turn it into geometry, and
 * `emit-layers.ts` finally produces ordinary `EditorLayer`s so the existing
 * Konva pipeline, undo/redo and export keep working untouched.
 *
 * Everything here is camelCase; the raw JSON is snake_case. The mapping lives in
 * `template-schema.ts` and nowhere else.
 */

/** `[left, top, right, bottom]` in the 800x800 logical space. */
export type Rect = [number, number, number, number];

/** `[width, height]` — a target box, not a region. */
export type Size = [number, number];

/** `[x, y]` in the logical space. */
export type Point = [number, number];

/** What a slot is for. Also the vocabulary `reserved_zones.avoid_for` uses. */
export type SlotRole = 'hero' | 'box' | 'secondary' | 'accent';

export type TemplateStatus = 'draft' | 'active' | 'retired';

export interface ReservedZone {
  id: string;
  box: Rect;
  /** Slot roles that must not intrude here (e.g. the store footer strip). */
  avoidFor: SlotRole[];
}

export interface TextZone {
  id: string;
  /** Free-form but conventionally one of `model_code` / `promo` / `title`. */
  role: string;
  box: Rect;
  /** e.g. `black_bold_serif` — parsed into TextLayer fields by the emit step. */
  fontStyle: string;
  align: 'left' | 'center' | 'right';
  maxLines: number;
}

/**
 * The「特写」rule: fit the material to the viewport, then zoom past it so the
 * canvas edge crops the subject — that is what makes it look like a close-up
 * rather than "a product shrunk to fit".
 */
export interface CloseupSpec {
  viewport: Rect;
  /** Which viewport dimension is fitted first; height suits tall products. */
  fit: 'height' | 'width';
  /** Multiplier applied AFTER the fit. 2.2 means 220% of the fitted size. */
  zoom: number;
  /** Which point of the content is pinned to the matching point of the viewport. */
  anchor: 'top_center';
  /** Explicit horizontal centre, overriding the viewport's own centre. */
  centerX: number;
  /**
   * `true` would need a real Konva clip group. Unsupported for now, and the
   * validator REJECTS it rather than silently ignoring it — a silently ignored
   * clip looks exactly like "the template lied".
   */
  clipToViewport: boolean;
}

/** One candidate placement for a slot that may move around (jitter / avoidance). */
export interface BoxVariant {
  center: Point;
  maxSize: Size;
}

/**
 * What to use when a slot's own material is missing.
 *
 * Declared as data on purpose: which fallback looks best is a merchandising
 * call, not a code fact, so the ladder is reorderable/disableable per template.
 */
export type SlotFallback =
  /** Any remaining material (another photo of the same product), contained to the slot box. */
  | { kind: 'secondary_view' }
  /** Mirror + shrink the hero into the slot. Needs layer opacity — not emitted yet. */
  | { kind: 'mirrored_copy'; of: 'hero'; opacity: number }
  /** A neutral plate carrying the model code, when no image can fill the slot. */
  | { kind: 'plate'; fill: string; cornerRadius: number; carries: 'model_code' | null }
  /** Leave the slot empty; the rest of the layout still applies. */
  | { kind: 'drop' };

export interface TemplateSlot {
  id: string;
  role: SlotRole;
  required: boolean;
  maxItems: number;
  /** Paint order: higher sits in front. Unique per template (validated). */
  zIndex: number;
  closeup?: CloseupSpec;
  variants?: BoxVariant[];
  fallbacks?: SlotFallback[];
}

export interface HeroDominanceRule {
  /** Hard floor for the hero's VISIBLE alpha area / canvas area. */
  minCanvasOccupancy: number;
  /** Preferred band; the solver aims at its midpoint. */
  targetCanvasOccupancy: [number, number];
}

export interface CollisionRule {
  preventAlphaOverlap: boolean;
  minGapPx: number;
}

export interface ShadowRule {
  enabled: boolean;
  /** 0-100 in the template (percent), converted to Konva's 0-1 by the emit step. */
  opacity: number;
  blur: number;
  offset: Point;
}

export interface TemplateRules {
  heroDominance: HeroDominanceRule;
  collision: CollisionRule;
  shadow: ShadowRule;
  packageReadability: {
    required: boolean;
    /**
     * Minimum ratio of the box's own alpha that must stay visible. Absent from
     * the shipped template: defaults to `DEFAULT_PACKAGE_VISIBLE_RATIO` and the
     * parser records a warning, so a future version can tune it without code.
     */
    minVisibleRatio: number;
  };
  text: {
    keepClearOfHero: boolean;
    preferBlackOnWhite: boolean;
  };
}

export interface TemplateCanvas {
  width: number;
  height: number;
  /** `#RRGGBB`. */
  background: string;
  safeMargin: number;
  reservedZones: ReservedZone[];
}

export interface LayoutTemplate {
  id: string;
  version: string;
  status: TemplateStatus;
  canvas: TemplateCanvas;
  textZones: TextZone[];
  slots: TemplateSlot[];
  rules: TemplateRules;
}
