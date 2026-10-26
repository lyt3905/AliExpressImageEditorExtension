/**
 * Turn a `CompositionPlan` into ordinary editor layers.
 *
 * This is the seam that keeps the whole feature cheap: once a plan becomes
 * `EditorLayer[]`, everything downstream already exists — Konva rendering, the
 * transformer, undo/redo, the exporter, 回填到商品页. Nothing in the editor has to
 * learn what a "template" is.
 *
 * It lives under `editor/` rather than `services/composition/` because building a
 * document is editor business; `services/` must not import from `editor/`.
 */

import { TEXT_LAYER_DEFAULTS } from '../../shared/constants';
import type { EditorLayer, ImageLayer, PlateLayer, TextLayer } from '../../shared/types';
import type { CompositionPlan } from '../../services/composition/planner';
import { createLayerId, createPlateLayer } from './editor-reducer';

function toImageLayer(image: CompositionPlan['images'][number]): ImageLayer {
  return {
    id: createLayerId(),
    kind: image.kind,
    materialId: image.materialId,
    blobId: image.blobId,
    sourceWidth: image.sourceWidth,
    sourceHeight: image.sourceHeight,
    // The plan already carries centre coordinates (`toLayerPlacement` folded the
    // alpha-trim offset in), which is exactly the layer model's convention.
    x: image.x,
    y: image.y,
    scale: image.scale,
    rotation: 0,
    flipX: false,
    flipY: false,
  };
}

function toTextLayer(text: CompositionPlan['texts'][number]): TextLayer {
  return {
    id: createLayerId(),
    kind: 'text',
    text: text.text,
    x: text.x,
    y: text.y,
    width: text.width,
    fontSize: text.fontSize,
    fontFamily: text.fontFamily,
    fill: text.fill,
    fontStyle: text.fontStyle,
    align: text.align,
    scale: 1,
    rotation: 0,
    flipX: false,
    flipY: false,
    // Outline and shadow stay off: the template's `text` rule only speaks about
    // colour and clearance, and inventing an outline would be a design decision
    // taken by the wrong layer of the stack.
    stroke: TEXT_LAYER_DEFAULTS.stroke,
    strokeWidth: TEXT_LAYER_DEFAULTS.strokeWidth,
    shadowColor: TEXT_LAYER_DEFAULTS.shadowColor,
    shadowBlur: TEXT_LAYER_DEFAULTS.shadowBlur,
    shadowOffsetX: TEXT_LAYER_DEFAULTS.shadowOffsetX,
    shadowOffsetY: TEXT_LAYER_DEFAULTS.shadowOffsetY,
    shadowOpacity: TEXT_LAYER_DEFAULTS.shadowOpacity,
  };
}

function toPlateLayer(plate: CompositionPlan['plates'][number]): PlateLayer {
  return createPlateLayer({
    width: plate.width,
    height: plate.height,
    fill: plate.fill,
    cornerRadius: plate.cornerRadius,
    x: plate.x,
    y: plate.y,
    scale: 1,
  });
}

/**
 * Paint order comes from `zIndex`, NOT from array order.
 *
 * `layers[0]` is the bottom of the stack, so the array must be sorted ascending.
 * Array.sort is stable, so equal z keeps the push order below: pictures, then
 * plates, then text — which is what makes a plate's own caption land above it even
 * though the caption uses `plateZ + 0.5` rather than a full step.
 */
export function planToLayers(plan: CompositionPlan): EditorLayer[] {
  const entries: Array<{ z: number; layer: EditorLayer }> = [
    ...plan.images.map((image) => ({ z: image.zIndex, layer: toImageLayer(image) as EditorLayer })),
    ...plan.plates.map((plate) => ({ z: plate.zIndex, layer: toPlateLayer(plate) as EditorLayer })),
    ...plan.texts.map((text) => ({ z: text.zIndex, layer: toTextLayer(text) as EditorLayer })),
  ];
  entries.sort((a, b) => a.z - b.z);
  return entries.map((entry) => entry.layer);
}
