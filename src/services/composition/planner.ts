/**
 * Compose a full composition plan from a template and the bound materials.
 *
 * This is where the two rules meet: `hero_dominance` says how big the subject
 * should be, `package_readability` says how much of the box must survive. They
 * pull in opposite directions, so the plan is produced in two passes —
 *
 *   1. pick the hero zoom that satisfies dominance (see `solve-hero.ts`);
 *   2. if the box ends up too hidden, back the zoom off step by step, re-scoring
 *      every variant at each step, until the box is visible enough.
 *
 * Pass 2 only ever REDUCES the zoom, and never below 1. So the composed result
 * can violate dominance but never silently crops the subject harder to rescue a
 * layout — and every compromise lands in `warnings`.
 *
 * The output is data only: no Konva, no blobs, no DOM. Turning it into layers is
 * the editor's job (`editor/state/compose-emit.ts`), which keeps `services/` free
 * of editor imports.
 */

import type { AlphaProfile } from './alpha';
import {
  canvasOccupancy,
  coveredFraction,
  toLayerPlacement,
  type CanvasSize,
  type ContentPlacement,
} from './coverage';
import { heroPlacement, solveHero } from './solve-hero';
import { solveBox, type BoxSolution } from './solve-box';
import { fitTextToBox, parseFontStyleSpec, textLayerGeometry, type MeasureText } from './text-fit';
import { round, warning, type CompositionWarning } from './warnings';
import type { LayoutTemplate, Rect, SlotRole, TemplateSlot, TextZone } from './types';

export type MaterialKind = 'cutout' | 'original' | 'brand';

export interface PlannerMaterial {
  materialId: string;
  blobId: string;
  kind: MaterialKind;
  profile: AlphaProfile;
  label?: string;
}

export interface PlacedImage {
  slotId: string;
  role: SlotRole;
  zIndex: number;
  materialId: string;
  blobId: string;
  kind: MaterialKind;
  sourceWidth: number;
  sourceHeight: number;
  /** Konva node centre. */
  x: number;
  y: number;
  scale: number;
  /** How much of this material stays visible under the layers above it. */
  visibleRatio: number;
}

export interface PlacedText {
  zoneId: string;
  role: string;
  zIndex: number;
  text: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  fontFamily: string;
  fontStyle: 'normal' | 'bold';
  align: 'left' | 'center' | 'right';
  fill: string;
}

/** A filled rounded rect — the "衬板" used when no package photo exists. */
export interface PlacedPlate {
  slotId: string;
  zIndex: number;
  /** Centre, like every other layer. */
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string;
  cornerRadius: number;
}

export interface CompositionPlan {
  templateId: string;
  templateVersion: string;
  canvas: { width: number; height: number; background: string };
  images: PlacedImage[];
  plates: PlacedPlate[];
  texts: PlacedText[];
  warnings: CompositionWarning[];
  diagnostics: {
    heroZoom: number;
    heroNominalZoom: number;
    heroOccupancy: number;
    boxVisibleRatio: number | null;
    boxVariantIndex: number | null;
    boxFallback: 'none' | 'secondary_view' | 'plate' | 'drop';
  };
}

export interface PlanRequest {
  template: LayoutTemplate;
  hero: PlannerMaterial;
  /** The package material, when the binder found one. */
  box?: PlannerMaterial | null;
  /** Extra material for the `secondary_view` fallback rung. */
  secondary?: PlannerMaterial | null;
  /** Model code for `model_code` text zones; absent = leave the zone empty. */
  modelCode?: string | null;
  /** Injected glyph measurement; required only when a text zone is filled. */
  measure?: MeasureText;
  /** Deterministic variant tie-break, by convention the product code. */
  seed?: string;
  /** Steps used when the box forces the hero zoom down. */
  boxSearchSteps?: number;
}

const DEFAULT_BOX_SEARCH_STEPS = 24;

/** Text sits above the photographs: the code must never be buried under them. */
export const TEXT_Z_INDEX = 1000;

/** Padding inside a plate before its caption is fitted. */
const PLATE_TEXT_PADDING_RATIO = 0.08;
const PLATE_TEXT_PADDING_MAX = 28;
const PLATE_TEXT_MIN_FONT = 12;
const PLATE_TEXT_MAX_FONT = 120;
const PLATE_TEXT_MAX_LINES = 3;

/**
 * The plate occupies the variant the hero covers least.
 *
 * A plate is a backdrop, so "which variant" is not about the plate's own
 * proportions (it has none) but about not being buried: with the hero leaning left,
 * picking the left-most variant would hide most of the plate — and its caption
 * along with it. Ties fall back to the first variant, keeping regenerations
 * identical.
 */
function buildPlate(
  slot: TemplateSlot,
  fill: string,
  cornerRadius: number,
  canvas: CanvasSize,
  avoidance: { profile: AlphaProfile; placement: ContentPlacement } | null,
): PlacedPlate | null {
  const variants = slot.variants ?? [];
  if (variants.length === 0) return null;

  let bestIndex = 0;
  let bestCoverage = Number.POSITIVE_INFINITY;
  variants.forEach((variant, index) => {
    const rect: Rect = [
      variant.center[0] - variant.maxSize[0] / 2,
      variant.center[1] - variant.maxSize[1] / 2,
      variant.center[0] + variant.maxSize[0] / 2,
      variant.center[1] + variant.maxSize[1] / 2,
    ];
    const coverage = avoidance
      ? coveredFraction(avoidance.profile, avoidance.placement, rect, canvas)
      : 0;
    // Strictly less: a tie keeps the earlier (authored) variant.
    if (coverage < bestCoverage) {
      bestCoverage = coverage;
      bestIndex = index;
    }
  });

  const variant = variants[bestIndex]!;
  return {
    slotId: slot.id,
    zIndex: slot.zIndex,
    x: variant.center[0],
    y: variant.center[1],
    width: variant.maxSize[0],
    height: variant.maxSize[1],
    fill,
    cornerRadius,
  };
}

/**
 * Caption for a plate that `carries: model_code`.
 *
 * Sits just above its plate (`z + 0.5`) rather than at `TEXT_Z_INDEX`: the code is
 * part of the backdrop, so it must stay where the plate is — floating it above the
 * hero would print a model number on top of the product.
 */
function buildPlateText(
  plate: PlacedPlate,
  modelCode: string,
  template: LayoutTemplate,
  measure: MeasureText | undefined,
): PlacedText | null {
  if (!measure) return null;
  const zone = modelCodeZone(template);
  const style = zone
    ? parseFontStyleSpec(zone.fontStyle)
    : { family: 'serif', weight: 'bold' as const, fill: '#000000' };

  const padding = Math.min(
    PLATE_TEXT_PADDING_MAX,
    Math.min(plate.width, plate.height) * PLATE_TEXT_PADDING_RATIO,
  );
  const width = Math.max(16, plate.width - padding * 2);
  const height = Math.max(16, plate.height - padding * 2);

  const fit = fitTextToBox({
    text: modelCode,
    maxWidth: width,
    maxHeight: height,
    fontFamily: style.family,
    weight: style.weight,
    maxLines: PLATE_TEXT_MAX_LINES,
    minFontSize: PLATE_TEXT_MIN_FONT,
    maxFontSize: PLATE_TEXT_MAX_FONT,
    measure,
  });

  return {
    zoneId: `${plate.slotId}:plate`,
    role: 'model_code',
    zIndex: plate.zIndex + 0.5,
    text: fit.lines.join('\n'),
    // Centred on the plate, in both axes.
    x: plate.x,
    y: plate.y,
    width,
    fontSize: fit.fontSize,
    fontFamily: style.family,
    fontStyle: style.weight,
    align: 'center',
    fill: style.fill,
  };
}

function findSlot(template: LayoutTemplate, role: SlotRole): TemplateSlot | null {
  return template.slots.find((slot) => slot.role === role) ?? null;
}

function modelCodeZone(template: LayoutTemplate): TextZone | null {
  return template.textZones.find((zone) => zone.role === 'model_code') ?? null;
}

function placedFromMaterial(
  material: PlannerMaterial,
  placement: ContentPlacement,
  slot: TemplateSlot,
): PlacedImage {
  const layer = toLayerPlacement(material.profile, placement);
  return {
    slotId: slot.id,
    role: slot.role,
    zIndex: slot.zIndex,
    materialId: material.materialId,
    blobId: material.blobId,
    kind: material.kind,
    sourceWidth: material.profile.sourceWidth,
    sourceHeight: material.profile.sourceHeight,
    x: layer.x,
    y: layer.y,
    scale: layer.scale,
    visibleRatio: 1,
  };
}

function buildText(
  zone: TextZone,
  modelCode: string,
  measure: MeasureText | undefined,
): { text: PlacedText | null; warning: CompositionWarning | null } {
  if (!measure) {
    return { text: null, warning: warning('text_does_not_fit', `文字区 ${zone.id} 需要字形测量，但调用方没有提供，已跳过`) };
  }
  const width = zone.box[2] - zone.box[0];
  const height = zone.box[3] - zone.box[1];
  const style = parseFontStyleSpec(zone.fontStyle);
  const fit = fitTextToBox({
    text: modelCode,
    maxWidth: width,
    maxHeight: height,
    fontFamily: style.family,
    weight: style.weight,
    maxLines: zone.maxLines,
    minFontSize: 12,
    maxFontSize: 200,
    measure,
  });
  const geometry = textLayerGeometry(zone, fit);
  const placed: PlacedText = {
    zoneId: zone.id,
    role: zone.role,
    zIndex: TEXT_Z_INDEX,
    text: fit.lines.join('\n'),
    x: geometry.x,
    y: geometry.y,
    width: geometry.width,
    fontSize: geometry.fontSize,
    fontFamily: style.family,
    fontStyle: style.weight,
    align: geometry.align,
    fill: style.fill,
  };
  if (!fit.fits) {
    return {
      text: placed,
      warning: warning(
        'text_does_not_fit',
        `「${modelCode}」在 ${zone.id} 里最小字号也放不下，已截断显示`,
        { zoneId: zone.id, minFontSize: fit.fontSize, maxLines: zone.maxLines },
      ),
    };
  }
  return { text: placed, warning: null };
}

export function buildCompositionPlan(request: PlanRequest): CompositionPlan {
  const {
    template,
    hero,
    box = null,
    secondary = null,
    modelCode = null,
    measure,
    seed = '',
    boxSearchSteps = DEFAULT_BOX_SEARCH_STEPS,
  } = request;

  const canvas: CanvasSize = { width: template.canvas.width, height: template.canvas.height };
  const warnings: CompositionWarning[] = [];
  const images: PlacedImage[] = [];
  const plates: PlacedPlate[] = [];
  const texts: PlacedText[] = [];
  /** Set when the code ended up on a plate instead of in the text zone. */
  let plateCarriesCode = false;

  const heroSlot = findSlot(template, 'hero');
  if (!heroSlot?.closeup) {
    throw new Error(`模板 ${template.id}@${template.version} 缺少 hero 槽位或 closeup 规则`);
  }
  const closeup = heroSlot.closeup;

  // ---- pass 1: dominance -------------------------------------------------
  const heroSolution = solveHero({
    profile: hero.profile,
    closeup,
    canvas,
    dominance: template.rules.heroDominance,
  });
  warnings.push(...heroSolution.warnings);

  let zoom = heroSolution.zoom;
  let placement = heroSolution.placement;
  let occupancy = heroSolution.occupancy;

  // ---- pass 2: package readability ---------------------------------------
  const boxSlot = findSlot(template, 'box');
  const minVisibleRatio = template.rules.packageReadability.minVisibleRatio;
  const boxMaterial = box ?? null;
  let boxSolution: BoxSolution | null = null;
  let boxFallback: CompositionPlan['diagnostics']['boxFallback'] = 'none';
  let boxSource: PlannerMaterial | null = null;

  const scoreBox = (candidate: PlannerMaterial, heroPlacementNow: ContentPlacement): BoxSolution | null =>
    boxSlot
      ? solveBox({
          profile: candidate.profile,
          variants: boxSlot.variants ?? [],
          canvas,
          minVisibleRatio,
          hero: { profile: hero.profile, placement: heroPlacementNow },
          seed,
        })
      : null;

  if (boxSlot && boxMaterial) {
    boxSource = boxMaterial;
    boxSolution = scoreBox(boxMaterial, placement);

    // Only now does the hero give ground: step the zoom down and re-score every
    // variant at each step. The top edge stays pinned throughout, so shrinking
    // can never push the subject up into the text zone.
    if (boxSolution && boxSolution.visibleRatio < minVisibleRatio) {
      const steps = Math.max(1, boxSearchSteps);
      let rescued: { zoom: number; placement: ContentPlacement; occupancy: number; box: BoxSolution } | null = null;
      for (let step = 1; step <= steps; step += 1) {
        const candidateZoom = zoom - (zoom - 1) * (step / steps);
        if (candidateZoom < 1) break;
        const candidatePlacement = heroPlacement(hero.profile, closeup, candidateZoom);
        const candidateBox = scoreBox(boxMaterial, candidatePlacement);
        if (!candidateBox) continue;
        if (candidateBox.visibleRatio >= minVisibleRatio) {
          rescued = {
            zoom: candidateZoom,
            placement: candidatePlacement,
            occupancy: canvasOccupancy(hero.profile, candidatePlacement, canvas),
            box: candidateBox,
          };
          break;
        }
      }

      if (rescued) {
        warnings.push(
          warning(
            'hero_zoom_reduced',
            `包装盒可读性要求主体让位：zoom ${round(zoom, 2)} → ${round(rescued.zoom, 2)}，主体占比降到 ${round(rescued.occupancy * 100, 1)}%`,
            {
              from: round(zoom, 2),
              to: round(rescued.zoom, 2),
              occupancy: round(rescued.occupancy),
              visibleRatio: round(rescued.box.visibleRatio),
            },
          ),
        );
        zoom = rescued.zoom;
        placement = rescued.placement;
        occupancy = rescued.occupancy;
        boxSolution = rescued.box;
      }
    }

    if (boxSolution) {
      warnings.push(...boxSolution.warnings);
      if (boxSolution.visibleRatio < minVisibleRatio) {
        // Already reported by solveBox; this line exists so the plan itself states
        // that the layout is knowingly off-spec rather than looking clean.
        warnings.push(
          warning('box_visibility_below_min', `包装盒最终可见 ${round(boxSolution.visibleRatio * 100, 1)}%，低于模板要求`, {
            visibleRatio: round(boxSolution.visibleRatio),
            threshold: minVisibleRatio,
          }),
        );
      }
    }
  } else if (boxSlot) {
    // No package material. Walk the template's fallback ladder; the first rung the
    // caller supplied material for wins.
    for (const fallback of boxSlot.fallbacks ?? []) {
      if (fallback.kind === 'secondary_view') {
        const surrogate = secondary ?? null;
        if (!surrogate) continue;
        boxSource = surrogate;
        boxFallback = 'secondary_view';
        boxSolution = scoreBox(surrogate, placement);
        warnings.push(
          warning('box_material_missing', `没有识别到包装盒，已用另一张素材「${surrogate.label ?? surrogate.materialId}」填位`),
        );
        break;
      }
      if (fallback.kind === 'plate') {
        boxFallback = 'plate';
        const plate = buildPlate(boxSlot, fallback.fill, fallback.cornerRadius, canvas, {
          profile: hero.profile,
          placement,
        });
        if (!plate) {
          warnings.push(
            warning('box_no_variant', '没有识别到包装盒，模板要求衬板补位但槽位没有坐标，本次右侧留空'),
          );
          break;
        }
        plates.push(plate);
        if (fallback.carries === 'model_code' && modelCode) {
          const caption = buildPlateText(plate, modelCode, template, measure);
          if (caption) {
            texts.push(caption);
            plateCarriesCode = true;
          }
        }
        warnings.push(
          warning(
            'box_material_missing',
            `没有识别到包装盒，已用衬板补位${
              fallback.carries === 'model_code' && modelCode ? '（型号写在衬板上）' : ''
            }`,
          ),
        );
        break;
      }
      if (fallback.kind === 'drop') {
        boxFallback = 'drop';
        warnings.push(warning('box_material_missing', '没有识别到包装盒，按模板兜底规则留空'));
        break;
      }
      // `mirrored_copy` needs layer opacity; skipping it must not look like success.
      warnings.push(warning('box_material_missing', '兜底规则 mirrored_copy 需要图层透明度，暂不支持，已跳过'));
    }
    if (boxFallback === 'none') {
      warnings.push(warning('box_material_missing', '没有识别到包装盒，模板也没有可用的兜底规则'));
    }
  }

  // ---- assemble ----------------------------------------------------------
  images.push(placedFromMaterial(hero, placement, heroSlot));
  if (boxSource && boxSolution) {
    const placed = placedFromMaterial(boxSource, boxSolution.placement, boxSlot!);
    images.push({ ...placed, visibleRatio: boxSolution.visibleRatio });
  }
  images.sort((a, b) => a.zIndex - b.zIndex);

  const zone = modelCodeZone(template);
  // Skipped when the code already sits on a plate: printing it twice on one 主图
  // looks like a mistake, and the plate caption is the more intentional of the two.
  if (zone && modelCode && !plateCarriesCode) {
    const built = buildText(zone, modelCode, measure);
    if (built.text) texts.push(built.text);
    if (built.warning) warnings.push(built.warning);
  }

  return {
    templateId: template.id,
    templateVersion: template.version,
    canvas: { width: template.canvas.width, height: template.canvas.height, background: template.canvas.background },
    images,
    plates,
    texts,
    warnings,
    diagnostics: {
      heroZoom: round(zoom, 3),
      heroNominalZoom: closeup.zoom,
      heroOccupancy: round(occupancy, 4),
      boxVisibleRatio: boxSolution ? round(boxSolution.visibleRatio, 4) : null,
      boxVariantIndex: boxSolution ? boxSolution.variantIndex : null,
      boxFallback,
    },
  };
}
