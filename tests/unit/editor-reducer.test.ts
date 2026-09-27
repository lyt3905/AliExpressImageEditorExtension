import { describe, expect, it } from 'vitest';
import { MAX_HISTORY } from '../../src/shared/constants';
import type { EditorLayer, EditorMaterial } from '../../src/shared/types';
import {
  addLayer,
  computeInitialPlacement,
  createEditorState,
  createLayerFromMaterial,
  deleteLayer,
  editorReducer,
  moveLayer,
  type EditorAction,
  type EditorState,
} from '../../src/editor/state/editor-reducer';
import { canRedo, canUndo } from '../../src/editor/state/history';

function makeDocument(count: number) {
  return { layers: Array.from({ length: count }, (_, index) => makeLayer(`layer-${index}`)) };
}

function makeLayer(id: string, patch: Partial<EditorLayer> = {}): EditorLayer {
  return {
    id,
    materialId: `material-${id}`,
    blobId: `blob-${id}`,
    sourceWidth: 1000,
    sourceHeight: 500,
    x: 400,
    y: 400,
    scale: 0.4,
    rotation: 0,
    kind: 'original',
    ...patch,
  };
}

function makeMaterial(patch: Partial<EditorMaterial> = {}): EditorMaterial {
  return {
    id: 'material-1',
    imageId: 'img-1',
    blobId: 'blob-1',
    kind: 'original',
    width: 1600,
    height: 1200,
    url: 'blob:fake',
    label: '原图',
    ...patch,
  };
}

function reduce(state: EditorState, actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

describe('layer operations', () => {
  it('adds a layer on top of the stack', () => {
    const doc = addLayer(makeDocument(1), makeLayer('layer-1'));
    expect(doc.layers.map((layer) => layer.id)).toEqual(['layer-0', 'layer-1']);
  });

  it('deletes a layer, and is a no-op for unknown ids', () => {
    const doc = makeDocument(2);
    expect(deleteLayer(doc, 'layer-0').layers.map((layer) => layer.id)).toEqual(['layer-1']);
    expect(deleteLayer(doc, 'nope')).toBe(doc);
  });

  it('moves a layer up and down within the stack', () => {
    const doc = makeDocument(3);
    expect(moveLayer(doc, 'layer-0', 'up').layers.map((layer) => layer.id)).toEqual([
      'layer-1',
      'layer-0',
      'layer-2',
    ]);
    expect(moveLayer(doc, 'layer-2', 'down').layers.map((layer) => layer.id)).toEqual([
      'layer-0',
      'layer-2',
      'layer-1',
    ]);
  });

  it('clamps the move at both ends', () => {
    const doc = makeDocument(2);
    expect(moveLayer(doc, 'layer-1', 'up')).toBe(doc);
    expect(moveLayer(doc, 'layer-0', 'down')).toBe(doc);
    expect(moveLayer(doc, 'missing', 'up')).toBe(doc);
  });
});

describe('initial placement', () => {
  it('scales the longest side to ~480 logical px and centres the layer', () => {
    const placement = computeInitialPlacement(1600, 1200);
    expect(placement).toEqual({ x: 400, y: 400, scale: 0.3 });
    expect(1600 * placement.scale).toBe(480);
  });

  it('never stretches: the aspect ratio is preserved by a single uniform scale', () => {
    const placement = computeInitialPlacement(900, 1600);
    expect(1600 * placement.scale).toBeCloseTo(480, 5);
    expect(900 * placement.scale).toBeCloseTo(270, 5);
  });

  it('caps the upscale of tiny sources', () => {
    const placement = computeInitialPlacement(60, 40);
    expect(placement.scale).toBe(2);
  });

  it('falls back to scale 1 for degenerate sizes', () => {
    expect(computeInitialPlacement(0, 0).scale).toBe(1);
  });
});

describe('createLayerFromMaterial', () => {
  it('derives size, kind and a uniform scale from the material', () => {
    const layer = createLayerFromMaterial(makeMaterial({ kind: 'cutout', width: 800, height: 800 }));
    expect(layer.kind).toBe('cutout');
    expect(layer.sourceWidth).toBe(800);
    expect(layer.sourceHeight).toBe(800);
    expect(layer.scale).toBeCloseTo(0.6, 5);
    expect(layer.rotation).toBe(0);
    expect(layer.x).toBe(400);
    expect(layer.y).toBe(400);
  });
});

describe('editorReducer history', () => {
  it('records committed edits and replays them with undo/redo', () => {
    const layer = makeLayer('layer-1');
    const added = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer }]);
    expect(added.history.present.layers).toHaveLength(1);
    expect(canUndo(added.history)).toBe(true);
    expect(canRedo(added.history)).toBe(false);

    const undone = editorReducer(added, { type: 'UNDO' });
    expect(undone.history.present.layers).toHaveLength(0);
    expect(canRedo(undone.history)).toBe(true);

    const redone = editorReducer(undone, { type: 'REDO' });
    expect(redone.history.present.layers).toHaveLength(1);
  });

  it('records dragEnd / transformEnd / reorder / delete / clear as single steps', () => {
    const state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('layer-1') },
      { type: 'ADD_LAYER', layer: makeLayer('layer-2') },
      { type: 'COMMIT_LAYER', layerId: 'layer-1', patch: { x: 123, y: 456 } },
      { type: 'MOVE_LAYER', layerId: 'layer-1', direction: 'up' },
      { type: 'DELETE_LAYER', layerId: 'layer-2' },
      { type: 'CLEAR' },
    ]);
    expect(state.history.present.layers).toHaveLength(0);
    expect(state.history.past).toHaveLength(6);

    const back = reduce(state, [
      { type: 'UNDO' },
      { type: 'UNDO' },
      { type: 'UNDO' },
    ]);
    // Undo #1 restores the pre-CLEAR stack, #2 the pre-DELETE stack, #3 the pre-MOVE stack.
    expect(back.history.present.layers.map((layer) => layer.id)).toEqual(['layer-1', 'layer-2']);
    expect(back.history.present.layers[0]?.x).toBe(123);
  });

  it('does not create history entries for live drag/transform frames', () => {
    const state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('layer-1') },
      { type: 'UPDATE_LAYER', layerId: 'layer-1', patch: { x: 10 } },
      { type: 'UPDATE_LAYER', layerId: 'layer-1', patch: { x: 20 } },
      { type: 'UPDATE_LAYER', layerId: 'layer-1', patch: { x: 30 } },
    ]);
    expect(state.history.past).toHaveLength(1);
    expect(state.history.present.layers[0]?.x).toBe(30);
  });

  it('caps the history stack', () => {
    let state = createEditorState();
    for (let index = 0; index < MAX_HISTORY + 20; index += 1) {
      state = editorReducer(state, { type: 'ADD_LAYER', layer: makeLayer(`layer-${index}`) });
    }
    expect(state.history.past.length).toBe(MAX_HISTORY);
  });

  it('clears the selection when the selected layer disappears', () => {
    let state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('layer-1') },
      { type: 'SELECT_LAYER', layerId: 'layer-1' },
    ]);
    expect(state.selectedLayerId).toBe('layer-1');
    state = editorReducer(state, { type: 'DELETE_LAYER', layerId: 'layer-1' });
    expect(state.selectedLayerId).toBeNull();
  });

  it('is a no-op for undo when there is nothing to undo', () => {
    const state = createEditorState();
    expect(editorReducer(state, { type: 'UNDO' })).toBe(state);
    expect(editorReducer(state, { type: 'REDO' })).toBe(state);
  });

  it('keeps the preview background when loading a stored document', () => {
    const state = editorReducer(
      { ...createEditorState(), showWhiteBackground: false },
      { type: 'LOAD_DOCUMENT', document: makeDocument(2) },
    );
    expect(state.showWhiteBackground).toBe(false);
    expect(state.history.present.layers).toHaveLength(2);
    expect(state.history.past).toHaveLength(0);
  });
});
