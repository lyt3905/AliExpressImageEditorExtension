/**
 * Editor document reducer.
 *
 * Layer order == z-order: `layers[0]` is the bottom of the stack.
 * Only committed edits touch history; live drag/transform frames use UPDATE_LAYER.
 */

import {
  CANVAS_SIZE,
  INSERT_MAX_SIDE,
  MAX_SHADOW_BLUR,
  MAX_SHADOW_OFFSET,
  MAX_STROKE_WIDTH,
  MIN_SHADOW_BLUR,
  MIN_SHADOW_OFFSET,
  MIN_STROKE_WIDTH,
  TEXT_LAYER_DEFAULTS,
} from '../../shared/constants';
import type {
  EditorDocument,
  EditorLayer,
  EditorMaterial,
  ImageLayer,
  LayerPatch,
  PlateLayer,
  TextLayer,
} from '../../shared/types';
import {
  clampNumber,
  finiteNumber,
  pickAlign,
  pickColor,
  pickFontStyle,
  pickTextStyle,
  type TextStyleDefaults,
} from '../../shared/text-style';
import {
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  redo,
  replacePresent,
  undo,
  type HistoryState,
} from './history';

/** Cap for auto-upscaling a tiny source image when it first lands on the canvas. */
export const MAX_INITIAL_UPSCALE = 2;

export interface EditorState {
  history: HistoryState;
  selectedLayerId: string | null;
  /** true = preview on white; false = preview on the checkerboard. */
  showWhiteBackground: boolean;
  exporting: boolean;
}

export function emptyDocument(): EditorDocument {
  return { layers: [] };
}

export function createEditorState(document: EditorDocument = emptyDocument()): EditorState {
  return {
    history: createHistory(document),
    selectedLayerId: null,
    showWhiteBackground: true,
    exporting: false,
  };
}

// ---------------------------------------------------------------- pure layer operations

export function addLayer(doc: EditorDocument, layer: EditorLayer): EditorDocument {
  return { layers: [...doc.layers, layer] };
}

/**
 * Insert a layer directly BELOW another layer (by id) in the z-order.
 *
 * Needed so the auto-added brand logo goes under the product-code text layer —
 * the code is meant to stay the topmost auto layer, but a plain ADD_LAYER would
 * push the logo above it.
 *
 * When `belowLayerId` is absent, this falls back to a plain append.
 */
export function insertLayerBelow(
  doc: EditorDocument,
  belowLayerId: string | null,
  layer: EditorLayer,
): EditorDocument {
  if (!belowLayerId) return addLayer(doc, layer);
  const index = doc.layers.findIndex((entry) => entry.id === belowLayerId);
  if (index < 0) return addLayer(doc, layer);
  const layers = [...doc.layers.slice(0, index), layer, ...doc.layers.slice(index)];
  return { layers };
}

export function deleteLayer(doc: EditorDocument, layerId: string): EditorDocument {
  const layers = doc.layers.filter((layer) => layer.id !== layerId);
  return layers.length === doc.layers.length ? doc : { layers };
}

/**
 * Merge a patch into one layer.
 *
 * `LayerPatch` only carries fields both kinds share plus the text-only ones, so
 * the result is always a valid member of the union — the cast just re-attaches
 * the discriminated `kind` that `updateLayer` preserves.
 */
function mergeLayer(layer: EditorLayer, patch: LayerPatch): EditorLayer {
  return { ...layer, ...patch, id: layer.id, kind: layer.kind } as EditorLayer;
}

export function updateLayer(doc: EditorDocument, layerId: string, patch: LayerPatch): EditorDocument {
  let changed = false;
  const layers = doc.layers.map((layer) => {
    if (layer.id !== layerId) return layer;
    changed = true;
    return mergeLayer(layer, patch);
  });
  return changed ? { layers } : doc;
}

/**
 * Move a layer one step in the stack.
 * 'up'   -> towards the viewer (later in the array / higher z)
 * 'down' -> away from the viewer (earlier in the array / lower z)
 */
export function moveLayer(doc: EditorDocument, layerId: string, direction: 'up' | 'down'): EditorDocument {
  const index = doc.layers.findIndex((layer) => layer.id === layerId);
  if (index < 0) return doc;
  const target = direction === 'up' ? index + 1 : index - 1;
  if (target < 0 || target >= doc.layers.length) return doc;

  const layers = [...doc.layers];
  const [moved] = layers.splice(index, 1);
  if (!moved) return doc;
  layers.splice(target, 0, moved);
  return { layers };
}

/** Centre the layer and scale its longest side to ~INSERT_MAX_SIDE without stretching. */
export function computeInitialPlacement(
  sourceWidth: number,
  sourceHeight: number,
  maxSide: number = INSERT_MAX_SIDE,
): { x: number; y: number; scale: number } {
  const longest = Math.max(sourceWidth, sourceHeight);
  const scale = longest > 0 ? Math.min(maxSide / longest, MAX_INITIAL_UPSCALE) : 1;
  return { x: CANVAS_SIZE / 2, y: CANVAS_SIZE / 2, scale };
}

let layerCounter = 0;

export function createLayerId(): string {
  layerCounter += 1;
  return `layer-${Date.now().toString(36)}-${layerCounter}`;
}

/** Build a ready-to-place picture layer from a material. */
export function createLayerFromMaterial(material: EditorMaterial): ImageLayer {
  const width = material.width > 0 ? material.width : INSERT_MAX_SIDE;
  const height = material.height > 0 ? material.height : INSERT_MAX_SIDE;
  const { x, y, scale } = computeInitialPlacement(width, height);
  return {
    id: createLayerId(),
    materialId: material.id,
    blobId: material.blobId,
    sourceWidth: width,
    sourceHeight: height,
    x,
    y,
    scale,
    rotation: 0,
    // Written explicitly so a fresh layer has exactly the shape the restore path
    // rebuilds — the flags can be absent in documents saved before mirroring.
    flipX: false,
    flipY: false,
    kind: material.kind,
  };
}

export function findLayer(doc: EditorDocument, layerId: string | null): EditorLayer | null {
  if (!layerId) return null;
  return doc.layers.find((layer) => layer.id === layerId) ?? null;
}

// ---------------------------------------------------------------- actions

export type EditorAction =
  | { type: 'ADD_LAYER'; layer: EditorLayer }
  | { type: 'ADD_LAYER_BELOW'; layer: EditorLayer; belowLayerId: string | null }
  /**
   * Replace the whole document with layers produced by a composition plan.
   *
   * One history entry for the entire layout: a generated 主图 is one action from
   * the user's point of view, so one undo has to take it away again. The layers
   * passed in are already in paint order (bottom first).
   *
   * `selectLayerId` pre-selects one of them (the caller passes the hero). A freshly
   * composed canvas looks the same as a restored one, and with nothing selected the
   * first drag goes to whatever is under the pointer — usually the backdrop plate,
   * which moves invisibly behind the product and reads as "拖动没反应".
   */
  | { type: 'APPLY_PLAN'; layers: EditorLayer[]; selectLayerId?: string | null }
  | { type: 'DELETE_LAYER'; layerId: string }
  | { type: 'UPDATE_LAYER'; layerId: string; patch: LayerPatch }
  | { type: 'COMMIT_LAYER'; layerId: string; patch: LayerPatch }
  | { type: 'MOVE_LAYER'; layerId: string; direction: 'up' | 'down' }
  | { type: 'SELECT_LAYER'; layerId: string | null }
  | { type: 'CLEAR' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'SET_BACKGROUND'; showWhite: boolean }
  | { type: 'SET_EXPORTING'; exporting: boolean }
  | { type: 'LOAD_DOCUMENT'; document: EditorDocument };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'ADD_LAYER':
      return { ...state, history: pushHistory(state.history, addLayer(state.history.present, action.layer)), selectedLayerId: action.layer.id };

    case 'ADD_LAYER_BELOW':
      return {
        ...state,
        history: pushHistory(
          state.history,
          insertLayerBelow(state.history.present, action.belowLayerId, action.layer),
        ),
        selectedLayerId: action.layer.id,
      };

    case 'APPLY_PLAN': {
      if (action.layers.length === 0) return state;
      const document: EditorDocument = { layers: action.layers };
      const selected = action.selectLayerId ?? null;
      return {
        ...state,
        history: pushHistory(state.history, document),
        selectedLayerId: document.layers.some((layer) => layer.id === selected) ? selected : null,
      };
    }

    case 'DELETE_LAYER': {
      const next = deleteLayer(state.history.present, action.layerId);
      if (next === state.history.present) return state;
      return {
        ...state,
        history: pushHistory(state.history, next),
        selectedLayerId: state.selectedLayerId === action.layerId ? null : state.selectedLayerId,
      };
    }

    case 'UPDATE_LAYER': {
      const next = updateLayer(state.history.present, action.layerId, action.patch);
      return next === state.history.present ? state : { ...state, history: replacePresent(state.history, next) };
    }

    case 'COMMIT_LAYER': {
      const next = updateLayer(state.history.present, action.layerId, action.patch);
      return next === state.history.present ? state : { ...state, history: pushHistory(state.history, next) };
    }

    case 'MOVE_LAYER': {
      const next = moveLayer(state.history.present, action.layerId, action.direction);
      return next === state.history.present ? state : { ...state, history: pushHistory(state.history, next) };
    }

    case 'SELECT_LAYER':
      return { ...state, selectedLayerId: action.layerId };

    case 'CLEAR': {
      if (state.history.present.layers.length === 0) return state;
      return { ...state, history: pushHistory(state.history, emptyDocument()), selectedLayerId: null };
    }

    case 'UNDO': {
      if (!canUndo(state.history)) return state;
      const history = undo(state.history);
      const stillExists = history.present.layers.some((layer) => layer.id === state.selectedLayerId);
      return { ...state, history, selectedLayerId: stillExists ? state.selectedLayerId : null };
    }

    case 'REDO': {
      if (!canRedo(state.history)) return state;
      const history = redo(state.history);
      const stillExists = history.present.layers.some((layer) => layer.id === state.selectedLayerId);
      return { ...state, history, selectedLayerId: stillExists ? state.selectedLayerId : null };
    }

    case 'SET_BACKGROUND':
      return state.showWhiteBackground === action.showWhite ? state : { ...state, showWhiteBackground: action.showWhite };

    case 'SET_EXPORTING':
      return state.exporting === action.exporting ? state : { ...state, exporting: action.exporting };

    case 'LOAD_DOCUMENT':
      return { ...createEditorState(action.document), showWhiteBackground: state.showWhiteBackground };

    default:
      return state;
  }
}

// ---------------------------------------------------------------- text layers

/**
 * Build a ready-to-place text layer, centred on the canvas.
 *
 * `defaults` is the remembered style (see `services/text-defaults.ts`), so a
 * new layer looks like the last one the user styled instead of snapping back
 * to 48px black. The copy, position and transform always restart fresh.
 */
export function createTextLayer(defaults?: Partial<TextStyleDefaults>): TextLayer {
  return {
    id: createLayerId(),
    kind: 'text',
    x: CANVAS_SIZE / 2,
    y: CANVAS_SIZE / 2,
    // Same reason as `createLayerFromMaterial`: keep the factory's shape and the
    // restore path's shape identical. `TEXT_LAYER_DEFAULTS` carries no mirror
    // flags, so neither spread below can overwrite these two.
    flipX: false,
    flipY: false,
    ...TEXT_LAYER_DEFAULTS,
    // Filtered through the same whitelist as the preference store, so even a
    // caller that smuggles `text` or `x` in cannot leak them onto a new layer.
    ...(pickTextStyle(defaults ?? {}) ?? {}),
  };
}

/**
 * Build the default text layer carrying the product code.
 *
 * Placement comes from the remembered preference (`code-placement.ts`): the
 * seller moved the last code somewhere, so the next one starts there. Centre-
 * aligned and wrapped to the default width so even a long code stays readable.
 */
export function createProductCodeTextLayer(
  productCode: string,
  defaults?: Partial<TextStyleDefaults>,
  placement?: { x: number; y: number; scale: number },
): TextLayer {
  const layer = createTextLayer(defaults);
  return {
    ...layer,
    text: productCode,
    x: placement?.x ?? layer.x,
    y: placement?.y ?? 48,
    scale: placement?.scale ?? layer.scale,
  };
}

/**
 * Approximate height before Konva has measured the node.
 *
 * Konva's default `lineHeight` is 1, so an unwrapped line is roughly `fontSize`
 * tall. `EditorStage` measures the real height right after the first paint and
 * corrects the node's `offsetY` with it.
 */
export function estimateTextHeight(layer: Pick<TextLayer, 'text' | 'fontSize'>): number {
  const lines = layer.text.split('\n').length;
  return Math.max(1, lines) * layer.fontSize;
}

/** Same rule for fields where a zero would be meaningless (`width`, `fontSize`, `scale`). */
function positiveNumber(value: unknown, fallback: number): number {
  const parsed = finiteNumber(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

/**
 * Rebuild a text layer from stored JSON.
 *
 * Only `id` is mandatory; every other field falls back to the default so a
 * partially-written document can never break the canvas. The same fallbacks are
 * what keep documents saved *before* outline/shadow existed readable — those
 * layers simply come back with both switched off.
 */
export function restoreTextLayer(raw: Record<string, unknown>): TextLayer | null {
  if (typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    kind: 'text',
    text: typeof raw.text === 'string' ? raw.text : TEXT_LAYER_DEFAULTS.text,
    x: finiteNumber(raw.x, CANVAS_SIZE / 2),
    y: finiteNumber(raw.y, CANVAS_SIZE / 2),
    width: positiveNumber(raw.width, TEXT_LAYER_DEFAULTS.width),
    fontSize: positiveNumber(raw.fontSize, TEXT_LAYER_DEFAULTS.fontSize),
    fontFamily:
      typeof raw.fontFamily === 'string' && raw.fontFamily
        ? raw.fontFamily
        : TEXT_LAYER_DEFAULTS.fontFamily,
    fill: pickColor(raw.fill, TEXT_LAYER_DEFAULTS.fill),
    fontStyle: pickFontStyle(raw.fontStyle, TEXT_LAYER_DEFAULTS.fontStyle),
    align: pickAlign(raw.align, TEXT_LAYER_DEFAULTS.align),
    scale: positiveNumber(raw.scale, TEXT_LAYER_DEFAULTS.scale),
    rotation: finiteNumber(raw.rotation, TEXT_LAYER_DEFAULTS.rotation),
    // Absent in documents written before mirroring existed — read as "not mirrored".
    flipX: raw.flipX === true,
    flipY: raw.flipY === true,
    stroke: pickColor(raw.stroke, TEXT_LAYER_DEFAULTS.stroke),
    strokeWidth: clampNumber(
      raw.strokeWidth,
      TEXT_LAYER_DEFAULTS.strokeWidth,
      MIN_STROKE_WIDTH,
      MAX_STROKE_WIDTH,
    ),
    shadowColor: pickColor(raw.shadowColor, TEXT_LAYER_DEFAULTS.shadowColor),
    shadowBlur: clampNumber(
      raw.shadowBlur,
      TEXT_LAYER_DEFAULTS.shadowBlur,
      MIN_SHADOW_BLUR,
      MAX_SHADOW_BLUR,
    ),
    shadowOffsetX: clampNumber(
      raw.shadowOffsetX,
      TEXT_LAYER_DEFAULTS.shadowOffsetX,
      MIN_SHADOW_OFFSET,
      MAX_SHADOW_OFFSET,
    ),
    shadowOffsetY: clampNumber(
      raw.shadowOffsetY,
      TEXT_LAYER_DEFAULTS.shadowOffsetY,
      MIN_SHADOW_OFFSET,
      MAX_SHADOW_OFFSET,
    ),
    // Konva's unit: 0–1, not a percentage.
    shadowOpacity: clampNumber(raw.shadowOpacity, TEXT_LAYER_DEFAULTS.shadowOpacity, 0, 1),
  };
}

// ---------------------------------------------------------------- plate layers

/** Default fill for a restored plate whose stored colour is unusable. */
const DEFAULT_PLATE_FILL = '#F5F5F5';

export interface PlateSpec {
  width: number;
  height: number;
  fill: string;
  cornerRadius: number;
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
}

/**
 * A filled rounded rectangle — the package-backdrop fallback.
 *
 * Built and restored through the same shape, like every other layer kind, so a
 * saved document and a freshly composed plan produce identical objects.
 */
export function createPlateLayer(spec: PlateSpec): PlateLayer {
  return {
    id: createLayerId(),
    kind: 'plate',
    x: spec.x ?? CANVAS_SIZE / 2,
    y: spec.y ?? CANVAS_SIZE / 2,
    width: Math.max(1, spec.width),
    height: Math.max(1, spec.height),
    fill: spec.fill,
    cornerRadius: Math.max(0, spec.cornerRadius),
    scale: spec.scale ?? 1,
    rotation: spec.rotation ?? 0,
    flipX: false,
    flipY: false,
  };
}

export function restorePlateLayer(raw: Record<string, unknown>): PlateLayer | null {
  if (typeof raw.id !== 'string' || !raw.id) return null;
  return {
    id: raw.id,
    kind: 'plate',
    x: finiteNumber(raw.x, CANVAS_SIZE / 2),
    y: finiteNumber(raw.y, CANVAS_SIZE / 2),
    // A zero size would be unselectable and unremovable on the canvas.
    width: positiveNumber(raw.width, 120),
    height: positiveNumber(raw.height, 120),
    fill: pickColor(raw.fill, DEFAULT_PLATE_FILL),
    cornerRadius: Math.max(0, finiteNumber(raw.cornerRadius, 0)),
    scale: positiveNumber(raw.scale, 1),
    rotation: finiteNumber(raw.rotation, 0),
    flipX: raw.flipX === true,
    flipY: raw.flipY === true,
  };
}

/**
 * Validate one layer read back from `chrome.storage.local`.
 *
 * Text and plate layers are rebuilt field by field; picture layers keep their
 * stored shape (the caller filters those by material availability afterwards).
 */
export function restoreStoredLayer(raw: unknown): EditorLayer | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !candidate.id) return null;

  if (candidate.kind === 'text') return restoreTextLayer(candidate);
  if (candidate.kind === 'plate') return restorePlateLayer(candidate);

  if (candidate.kind !== 'original' && candidate.kind !== 'cutout' && candidate.kind !== 'brand') return null;
  if (typeof candidate.materialId !== 'string') return null;
  return candidate as unknown as ImageLayer;
}

/**
 * Drop picture layers whose material is gone, keeping text, plate and brand layers.
 *
 * Text and plate layers carry no `materialId`, so a naive material check would
 * erase all of them on every editor reload. Brand logo layers are kept too: their blobs
 * live in the shared IndexedDB store and their materials are rebuilt by the
 * editor from the brand registry, independent of the session's image list.
 */
export function keepLayerWithMaterials(
  layers: readonly EditorLayer[],
  materialIds: ReadonlySet<string>,
): EditorLayer[] {
  return layers.filter(
    (layer) =>
      layer.kind === 'text' ||
      layer.kind === 'plate' ||
      layer.kind === 'brand' ||
      materialIds.has(layer.materialId),
  );
}
