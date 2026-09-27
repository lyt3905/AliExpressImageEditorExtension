/**
 * Editor document reducer.
 *
 * Layer order == z-order: `layers[0]` is the bottom of the stack.
 * Only committed edits touch history; live drag/transform frames use UPDATE_LAYER.
 */

import { CANVAS_SIZE, INSERT_MAX_SIDE } from '../../shared/constants';
import type { EditorDocument, EditorLayer, EditorMaterial } from '../../shared/types';
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
  notice: string | null;
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
    notice: null,
  };
}

// ---------------------------------------------------------------- pure layer operations

export function addLayer(doc: EditorDocument, layer: EditorLayer): EditorDocument {
  return { layers: [...doc.layers, layer] };
}

export function deleteLayer(doc: EditorDocument, layerId: string): EditorDocument {
  const layers = doc.layers.filter((layer) => layer.id !== layerId);
  return layers.length === doc.layers.length ? doc : { layers };
}

export function updateLayer(doc: EditorDocument, layerId: string, patch: Partial<EditorLayer>): EditorDocument {
  let changed = false;
  const layers = doc.layers.map((layer) => {
    if (layer.id !== layerId) return layer;
    changed = true;
    return { ...layer, ...patch, id: layer.id };
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

/** Build a ready-to-place layer from a material. */
export function createLayerFromMaterial(material: EditorMaterial): EditorLayer {
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
  | { type: 'DELETE_LAYER'; layerId: string }
  | { type: 'UPDATE_LAYER'; layerId: string; patch: Partial<EditorLayer> }
  | { type: 'COMMIT_LAYER'; layerId: string; patch: Partial<EditorLayer> }
  | { type: 'MOVE_LAYER'; layerId: string; direction: 'up' | 'down' }
  | { type: 'SELECT_LAYER'; layerId: string | null }
  | { type: 'CLEAR' }
  | { type: 'UNDO' }
  | { type: 'REDO' }
  | { type: 'SET_BACKGROUND'; showWhite: boolean }
  | { type: 'SET_EXPORTING'; exporting: boolean }
  | { type: 'SET_NOTICE'; notice: string | null }
  | { type: 'LOAD_DOCUMENT'; document: EditorDocument };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'ADD_LAYER':
      return { ...state, history: pushHistory(state.history, addLayer(state.history.present, action.layer)), selectedLayerId: action.layer.id };

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

    case 'SET_NOTICE':
      return { ...state, notice: action.notice };

    case 'LOAD_DOCUMENT':
      return { ...createEditorState(action.document), showWhiteBackground: state.showWhiteBackground };

    default:
      return state;
  }
}
