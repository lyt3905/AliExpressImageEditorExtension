import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_EFFECTS, IMAGE_EFFECT_LIMITS, MAX_HISTORY } from '../../src/shared/constants';
import type { EditorMaterial, ImageLayer } from '../../src/shared/types';
import { normalizeImageEffects } from '../../src/services/image-effects';
import {
  addLayer,
  computeInitialPlacement,
  createEditorState,
  createLayerFromMaterial,
  createPlateLayer,
  createTextLayer,
  deleteLayer,
  editorReducer,
  flipAllImagesX,
  insertLayerBelow,
  moveLayer,
  type EditorAction,
  type EditorState,
} from '../../src/editor/state/editor-reducer';
import { canRedo, canUndo } from '../../src/editor/state/history';

function makeDocument(count: number) {
  return { layers: Array.from({ length: count }, (_, index) => makeLayer(`layer-${index}`)) };
}

function makeLayer(id: string, patch: Partial<ImageLayer> = {}): ImageLayer {
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

  it('inserts a layer directly below the named layer', () => {
    const doc = makeDocument(2);
    const next = insertLayerBelow(doc, 'layer-1', makeLayer('logo'));
    expect(next.layers.map((layer) => layer.id)).toEqual(['layer-0', 'logo', 'layer-1']);
  });

  it('falls back to the top when the anchor id is unknown or absent', () => {
    const doc = makeDocument(2);
    expect(insertLayerBelow(doc, 'missing', makeLayer('logo')).layers.map((layer) => layer.id)).toEqual([
      'layer-0',
      'layer-1',
      'logo',
    ]);
    expect(insertLayerBelow(doc, null, makeLayer('logo')).layers.map((layer) => layer.id)).toEqual([
      'layer-0',
      'layer-1',
      'logo',
    ]);
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

describe('document background', () => {
  it('stores a normalized colour as one undoable step', () => {
    let state = reduce(createEditorState(), [{ type: 'SET_DOCUMENT_BACKGROUND', color: '#ABC' }]);
    expect(state.history.present.background).toBe('#aabbcc');
    expect(canUndo(state.history)).toBe(true);
    state = reduce(state, [{ type: 'UNDO' }]);
    expect(state.history.present.background).toBeUndefined();
  });

  it('does not push history when the colour is already that colour', () => {
    const state = reduce(createEditorState(), [
      { type: 'SET_DOCUMENT_BACKGROUND', color: '#171719' },
      { type: 'SET_DOCUMENT_BACKGROUND', color: '#171719'.toUpperCase() },
    ]);
    expect(state.history.present.background).toBe('#171719');
    expect(canUndo(state.history)).toBe(true);
    expect(canRedo(state.history)).toBe(false);
  });

  it('keeps the background across layer operations', () => {
    const state = reduce(createEditorState(), [
      { type: 'SET_DOCUMENT_BACKGROUND', color: '#171719' },
      { type: 'ADD_LAYER', layer: makeLayer('layer-1') },
      { type: 'DELETE_LAYER', layerId: 'layer-1' },
    ]);
    expect(state.history.present.background).toBe('#171719');
  });

  it('applies the plan background together with the layers, as one step', () => {
    const state = reduce(createEditorState(), [
      { type: 'APPLY_PLAN', layers: [makeLayer('layer-9')], selectLayerId: null, background: '#0e0e10' },
    ]);
    expect(state.history.present.layers.map((layer) => layer.id)).toEqual(['layer-9']);
    expect(state.history.present.background).toBe('#0e0e10');
    expect(canUndo(state.history)).toBe(true);
  });

  it('keeps the current background when the plan does not declare one', () => {
    const state = reduce(createEditorState(), [
      { type: 'SET_DOCUMENT_BACKGROUND', color: '#171719' },
      { type: 'APPLY_PLAN', layers: [makeLayer('layer-9')], selectLayerId: null },
    ]);
    expect(state.history.present.background).toBe('#171719');
  });

  it('repairs a broken stored background when the document is loaded', () => {
    const state = reduce(createEditorState(), [
      { type: 'LOAD_DOCUMENT', document: { layers: [], background: 'nope' } },
    ]);
    expect(state.history.present.background).toBe('#ffffff');
  });
});

describe('layer lock', () => {
  it('toggles `locked` through a COMMIT_LAYER patch and leaves it in the document', () => {
    let state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('logo', { kind: 'brand', locked: true }) },
    ]);
    expect((state.history.present.layers[0] as ImageLayer).locked).toBe(true);

    state = editorReducer(state, { type: 'COMMIT_LAYER', layerId: 'logo', patch: { locked: false } });
    expect((state.history.present.layers[0] as ImageLayer).locked).toBe(false);
    // A real toggle is one undoable step, and undo brings the lock back.
    expect(state.history.past).toHaveLength(2);
    state = editorReducer(state, { type: 'UNDO' });
    expect((state.history.present.layers[0] as ImageLayer).locked).toBe(true);
  });

  it('does not let a lock patch change the identity of the layer', () => {
    const state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('logo', { kind: 'brand', locked: true }) },
      { type: 'COMMIT_LAYER', layerId: 'logo', patch: { locked: false } },
    ]);
    const layer = state.history.present.layers[0] as ImageLayer;
    expect(layer.id).toBe('logo');
    expect(layer.kind).toBe('brand');
  });
});

describe('picture effects', () => {
  it('keeps a committed effect block in the document, normalised', () => {
    let state = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: makeLayer('photo') }]);

    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId: 'photo',
      // Out of range on purpose: the reducer owns the clamp, not the panel.
      patch: { effects: normalizeImageEffects({ opacity: 2, glowBlur: 999, glowOpacity: 0.4 }) },
    });

    const layer = state.history.present.layers[0] as ImageLayer;
    expect(layer.effects?.opacity).toBe(1);
    expect(layer.effects?.glowBlur).toBe(IMAGE_EFFECT_LIMITS.glowBlur);
    expect(layer.effects?.glowOpacity).toBe(0.4);
  });

  it('is one undoable step, and undo restores the previous effects', () => {
    let state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('photo', { effects: normalizeImageEffects({ grayscale: true }) }) },
    ]);
    const depth = state.history.past.length;

    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId: 'photo',
      patch: { effects: normalizeImageEffects({ opacity: 0.6 }) },
    });
    expect(state.history.past).toHaveLength(depth + 1);
    expect((state.history.present.layers[0] as ImageLayer).effects?.grayscale).toBe(false);

    state = editorReducer(state, { type: 'UNDO' });
    expect((state.history.present.layers[0] as ImageLayer).effects?.grayscale).toBe(true);
  });

  it('never leaves an effect block on a text layer', () => {
    const text = createTextLayer();
    const state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: text },
      {
        type: 'COMMIT_LAYER',
        layerId: text.id,
        patch: { effects: normalizeImageEffects({ opacity: 0.2 }) },
      },
    ]);
    const stored = state.history.present.layers[0];
    expect(stored.kind).toBe('text');
    expect(stored).not.toHaveProperty('effects');
  });

  it('repairs a stored block that a older build left out of range', () => {
    const broken = makeLayer('photo');
    // Written straight into the document, as a restored JSON blob would be.
    broken.effects = { ...DEFAULT_IMAGE_EFFECTS, opacity: 12, shadowBlur: 999 } as ImageLayer['effects'];

    const state = reduce(createEditorState(), [
      { type: 'LOAD_DOCUMENT', document: { layers: [broken] } },
    ]);

    const layer = state.history.present.layers[0] as ImageLayer;
    expect(layer.effects?.opacity).toBe(1);
    expect(layer.effects?.shadowBlur).toBe(IMAGE_EFFECT_LIMITS.shadowBlur);
  });
});

describe('FLIP_ALL_IMAGES_X', () => {  it('toggles each 原图 / 抠图 flipX independently', () => {
    // One unset flag and one already mirrored: the batch is a toggle per layer,
    // not "set everything to true".
    const state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('original-1') },
      { type: 'ADD_LAYER', layer: makeLayer('cutout-1', { kind: 'cutout', flipX: true }) },
      { type: 'FLIP_ALL_IMAGES_X' },
    ]);

    expect(state.history.present.layers.map((layer) => layer.flipX)).toEqual([true, false]);
  });

  it('leaves 品牌 / 文字 / 衬板 layers untouched (same references)', () => {
    const brand = makeLayer('brand-1', { kind: 'brand' });
    const text = createTextLayer();
    const plate = createPlateLayer({ width: 200, height: 120, fill: '#F5F5F5', cornerRadius: 8 });

    const state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('original-1') },
      { type: 'ADD_LAYER', layer: brand },
      { type: 'ADD_LAYER', layer: text },
      { type: 'ADD_LAYER', layer: plate },
      { type: 'FLIP_ALL_IMAGES_X' },
    ]);

    const [original, nextBrand, nextText, nextPlate] = state.history.present.layers;
    expect(original?.flipX).toBe(true);
    expect(nextBrand).toBe(brand);
    expect(nextText).toBe(text);
    expect(nextPlate).toBe(plate);
  });

  it('records the whole batch as exactly one history step, and undo reverts every flag', () => {
    const before = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('original-1') },
      { type: 'ADD_LAYER', layer: makeLayer('cutout-1', { kind: 'cutout', flipX: true }) },
    ]);

    const flipped = editorReducer(before, { type: 'FLIP_ALL_IMAGES_X' });
    expect(flipped.history.past.length).toBe(before.history.past.length + 1);
    expect(flipped.history.present.layers.map((layer) => layer.flipX)).toEqual([true, false]);

    const undone = editorReducer(flipped, { type: 'UNDO' });
    expect(undone.history.present.layers.map((layer) => layer.flipX)).toEqual([undefined, true]);
  });

  it('keeps the current selection across the batch', () => {
    const state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('original-1') },
      { type: 'ADD_LAYER', layer: makeLayer('cutout-1', { kind: 'cutout' }) },
      { type: 'FLIP_ALL_IMAGES_X' },
    ]);

    // ADD_LAYER selects the added layer; flipping every picture keeps it selected.
    expect(state.selectedLayerId).toBe('cutout-1');
    expect(state.history.present.layers.map((layer) => layer.flipX)).toEqual([true, true]);
  });

  it('is a no-op that keeps the same state reference on an empty canvas', () => {
    const state = createEditorState();
    const next = editorReducer(state, { type: 'FLIP_ALL_IMAGES_X' });

    expect(next).toBe(state);
    expect(state.history.past).toHaveLength(0);
  });

  it('returns the same document and state when there is nothing to mirror', () => {
    // 品牌 Logo, 文字 and 衬板 alone are not a reason to spend an undo step.
    const state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: makeLayer('brand-1', { kind: 'brand' }) },
      { type: 'ADD_LAYER', layer: createTextLayer() },
    ]);
    const document = state.history.present;

    expect(flipAllImagesX(document)).toBe(document);
    expect(editorReducer(state, { type: 'FLIP_ALL_IMAGES_X' })).toBe(state);
  });
});
