import { describe, expect, it } from 'vitest';
import {
  CANVAS_SIZE,
  MAX_SHADOW_BLUR,
  MAX_SHADOW_OFFSET,
  MIN_SHADOW_OFFSET,
  TEXT_LAYER_DEFAULTS,
} from '../../src/shared/constants';
import type { EditorLayer, EditorMaterial, ImageLayer, TextLayer } from '../../src/shared/types';
import {
  createEditorState,
  createLayerFromMaterial,
  createTextLayer,
  editorReducer,
  estimateTextHeight,
  keepLayerWithMaterials,
  moveLayer,
  restoreStoredLayer,
  restoreTextLayer,
  type EditorAction,
  type EditorState,
} from '../../src/editor/state/editor-reducer';

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

function makeImageLayer(id: string, patch: Partial<ImageLayer> = {}): ImageLayer {
  return {
    id,
    kind: 'original',
    materialId: `material-${id}`,
    blobId: `blob-${id}`,
    sourceWidth: 1000,
    sourceHeight: 500,
    x: 400,
    y: 400,
    scale: 0.4,
    rotation: 0,
    ...patch,
  };
}

function reduce(state: EditorState, actions: EditorAction[]): EditorState {
  return actions.reduce(editorReducer, state);
}

function textLayerAt(state: EditorState, id: string): TextLayer {
  const layer = state.history.present.layers.find((entry) => entry.id === id);
  if (!layer || layer.kind !== 'text') throw new Error(`text layer ${id} is missing`);
  return layer;
}

describe('createTextLayer', () => {
  it('uses the documented defaults', () => {
    const layer = createTextLayer();

    expect(layer.kind).toBe('text');
    expect(layer.text).toBe(TEXT_LAYER_DEFAULTS.text);
    expect(layer.fontSize).toBe(TEXT_LAYER_DEFAULTS.fontSize);
    expect(layer.fontFamily).toBe(TEXT_LAYER_DEFAULTS.fontFamily);
    expect(layer.fill).toBe(TEXT_LAYER_DEFAULTS.fill);
    expect(layer.fontStyle).toBe('normal');
    expect(layer.align).toBe('center');
    expect(layer.scale).toBe(1);
    expect(layer.rotation).toBe(0);
    expect(layer.x).toBe(CANVAS_SIZE / 2);
    expect(layer.y).toBe(CANVAS_SIZE / 2);
  });

  it('starts with the outline and the shadow switched off', () => {
    const layer = createTextLayer();

    expect(layer.strokeWidth).toBe(0);
    expect(layer.shadowBlur).toBe(0);
    expect(layer.shadowOffsetX).toBe(0);
    expect(layer.shadowOffsetY).toBe(0);
    expect(layer.stroke).toBe(TEXT_LAYER_DEFAULTS.stroke);
    expect(layer.shadowColor).toBe(TEXT_LAYER_DEFAULTS.shadowColor);
    expect(layer.shadowOpacity).toBe(TEXT_LAYER_DEFAULTS.shadowOpacity);
  });

  it('never carries picture-only fields', () => {
    const layer = createTextLayer();

    expect('materialId' in layer).toBe(false);
    expect('blobId' in layer).toBe(false);
    expect('sourceWidth' in layer).toBe(false);
    expect('sourceHeight' in layer).toBe(false);
  });

  it('gives every layer a distinct id', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createTextLayer().id));
    expect(ids.size).toBe(20);
  });
});

describe('text layers in the reducer', () => {
  it('adds a text layer on top and selects it', () => {
    const text = createTextLayer();
    const state = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: text }]);

    expect(state.history.present.layers).toHaveLength(1);
    expect(state.selectedLayerId).toBe(text.id);
  });

  it('deletes a text layer and clears the selection', () => {
    const text = createTextLayer();
    const state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: text },
      { type: 'DELETE_LAYER', layerId: text.id },
    ]);

    expect(state.history.present.layers).toHaveLength(0);
    expect(state.selectedLayerId).toBeNull();
  });

  it('reorders text and pictures within the same stack', () => {
    const image = makeImageLayer('layer-img');
    const text = createTextLayer();

    let state = reduce(createEditorState(), [
      { type: 'ADD_LAYER', layer: image },
      { type: 'ADD_LAYER', layer: text },
    ]);
    expect(state.history.present.layers.map((layer) => layer.id)).toEqual([image.id, text.id]);

    state = editorReducer(state, { type: 'MOVE_LAYER', layerId: text.id, direction: 'down' });
    expect(state.history.present.layers.map((layer) => layer.id)).toEqual([text.id, image.id]);

    state = editorReducer(state, { type: 'MOVE_LAYER', layerId: text.id, direction: 'up' });
    expect(state.history.present.layers.map((layer) => layer.id)).toEqual([image.id, text.id]);
  });

  it('reorders with the pure moveLayer helper too', () => {
    const image = makeImageLayer('layer-img');
    const text = createTextLayer();
    const doc = { layers: [image, text] as EditorLayer[] };

    expect(moveLayer(doc, text.id, 'down').layers.map((layer) => layer.id)).toEqual([text.id, image.id]);
    expect(moveLayer(doc, image.id, 'up').layers.map((layer) => layer.id)).toEqual([text.id, image.id]);
  });

  it('keeps picture layers working through createLayerFromMaterial', () => {
    const layer = createLayerFromMaterial(makeMaterial({ kind: 'cutout', width: 800, height: 800 }));

    expect(layer.kind).toBe('cutout');
    expect(layer.sourceWidth).toBe(800);
  });
});

describe('text edit history', () => {
  it('add / undo / redo round-trips a text layer', () => {
    const text = createTextLayer();
    const added = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: text }]);
    expect(added.history.present.layers).toHaveLength(1);

    const undone = editorReducer(added, { type: 'UNDO' });
    expect(undone.history.present.layers).toHaveLength(0);

    const redone = editorReducer(undone, { type: 'REDO' });
    expect(redone.history.present.layers).toHaveLength(1);
    expect(redone.history.present.layers[0]?.id).toBe(text.id);
  });

  it('undoes a finished text edit to the previous value and redoes it', () => {
    const text = createTextLayer();
    let state = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: text }]);
    state = editorReducer(state, { type: 'COMMIT_LAYER', layerId: text.id, patch: { text: 'Summer' } });
    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId: text.id,
      patch: { text: 'Summer Sale' },
    });
    expect(textLayerAt(state, text.id).text).toBe('Summer Sale');

    state = editorReducer(state, { type: 'UNDO' });
    expect(textLayerAt(state, text.id).text).toBe('Summer');

    state = editorReducer(state, { type: 'REDO' });
    expect(textLayerAt(state, text.id).text).toBe('Summer Sale');
  });

  it('records one history step per committed edit, not per keystroke', () => {
    const text = createTextLayer();
    let state = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: text }]);
    const before = state.history.past.length;

    // The panel keeps a local draft while typing and commits once on blur.
    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId: text.id,
      patch: { text: 'Summer Sale' },
    });

    expect(state.history.past.length).toBe(before + 1);
  });

  it('commits style changes and can undo them', () => {
    const text = createTextLayer();
    let state = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: text }]);
    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId: text.id,
      patch: { fontSize: 72, fill: '#ff0000', fontStyle: 'bold', align: 'left' },
    });

    const styled = textLayerAt(state, text.id);
    expect(styled.fontSize).toBe(72);
    expect(styled.fill).toBe('#ff0000');
    expect(styled.fontStyle).toBe('bold');
    expect(styled.align).toBe('left');

    state = editorReducer(state, { type: 'UNDO' });
    const reverted = textLayerAt(state, text.id);
    expect(reverted.fontSize).toBe(TEXT_LAYER_DEFAULTS.fontSize);
    expect(reverted.fill).toBe(TEXT_LAYER_DEFAULTS.fill);
    expect(reverted.fontStyle).toBe('normal');
    expect(reverted.align).toBe('center');
  });

  it('commits drag / transform geometry without disturbing the text', () => {
    const text = createTextLayer();
    let state = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: text }]);
    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId: text.id,
      patch: { x: 120, y: 340, scale: 1.8, rotation: 30 },
    });

    const moved = textLayerAt(state, text.id);
    expect(moved.x).toBe(120);
    expect(moved.y).toBe(340);
    expect(moved.scale).toBe(1.8);
    expect(moved.rotation).toBe(30);
    expect(moved.text).toBe(TEXT_LAYER_DEFAULTS.text);
  });
});

describe('text layer restore', () => {
  it('rebuilds a fully specified layer', () => {
    const layer = restoreTextLayer({
      id: 'layer-t',
      kind: 'text',
      text: 'SUMMER SALE',
      x: 100,
      y: 200,
      width: 500,
      fontSize: 64,
      fontFamily: 'Arial',
      fill: '#123456',
      fontStyle: 'bold',
      align: 'right',
      scale: 1.5,
      rotation: 45,
      stroke: '#ffffff',
      strokeWidth: 5,
      shadowColor: '#111111',
      shadowBlur: 16,
      shadowOffsetX: -6,
      shadowOffsetY: 8,
      shadowOpacity: 0.75,
    });

    expect(layer).toEqual({
      id: 'layer-t',
      kind: 'text',
      text: 'SUMMER SALE',
      x: 100,
      y: 200,
      width: 500,
      fontSize: 64,
      fontFamily: 'Arial',
      fill: '#123456',
      fontStyle: 'bold',
      align: 'right',
      scale: 1.5,
      rotation: 45,
      stroke: '#ffffff',
      strokeWidth: 5,
      shadowColor: '#111111',
      shadowBlur: 16,
      shadowOffsetX: -6,
      shadowOffsetY: 8,
      shadowOpacity: 0.75,
    });
  });

  it('falls back to defaults for every missing field', () => {
    const layer = restoreTextLayer({ id: 'layer-t' });

    expect(layer?.text).toBe(TEXT_LAYER_DEFAULTS.text);
    expect(layer?.fontSize).toBe(TEXT_LAYER_DEFAULTS.fontSize);
    expect(layer?.fontFamily).toBe(TEXT_LAYER_DEFAULTS.fontFamily);
    expect(layer?.fill).toBe(TEXT_LAYER_DEFAULTS.fill);
    expect(layer?.width).toBe(TEXT_LAYER_DEFAULTS.width);
    expect(layer?.align).toBe('center');
    expect(layer?.fontStyle).toBe('normal');
    expect(layer?.scale).toBe(1);
    expect(layer?.rotation).toBe(0);
    expect(layer?.x).toBe(CANVAS_SIZE / 2);
    expect(layer?.y).toBe(CANVAS_SIZE / 2);
    expect(layer?.strokeWidth).toBe(0);
    expect(layer?.shadowBlur).toBe(0);
    expect(layer?.shadowOffsetX).toBe(0);
    expect(layer?.shadowOffsetY).toBe(0);
    expect(layer?.stroke).toBe(TEXT_LAYER_DEFAULTS.stroke);
    expect(layer?.shadowColor).toBe(TEXT_LAYER_DEFAULTS.shadowColor);
    expect(layer?.shadowOpacity).toBe(TEXT_LAYER_DEFAULTS.shadowOpacity);
  });

  it('clamps out-of-range outline and shadow values instead of passing them to Konva', () => {
    const layer = restoreTextLayer({
      id: 'layer-c',
      stroke: '   ',
      strokeWidth: -5,
      shadowColor: '',
      shadowBlur: 9999,
      shadowOffsetX: -9999,
      shadowOffsetY: 9999,
      shadowOpacity: 3,
    });

    // A negative width is a user asking for "no outline", not for a negative one.
    expect(layer?.strokeWidth).toBe(0);
    expect(layer?.shadowBlur).toBe(MAX_SHADOW_BLUR);
    expect(layer?.shadowOffsetX).toBe(MIN_SHADOW_OFFSET);
    expect(layer?.shadowOffsetY).toBe(MAX_SHADOW_OFFSET);
    expect(layer?.shadowOpacity).toBe(1);
    expect(layer?.stroke).toBe(TEXT_LAYER_DEFAULTS.stroke);
    expect(layer?.shadowColor).toBe(TEXT_LAYER_DEFAULTS.shadowColor);
  });

  it('falls back to the default when an outline or shadow field is not a number', () => {
    const layer = restoreTextLayer({
      id: 'layer-n',
      strokeWidth: 'wide',
      shadowBlur: null,
      shadowOffsetX: 'left',
      shadowOffsetY: Number.NaN,
      shadowOpacity: 'opaque',
    });

    expect(layer?.strokeWidth).toBe(TEXT_LAYER_DEFAULTS.strokeWidth);
    expect(layer?.shadowBlur).toBe(TEXT_LAYER_DEFAULTS.shadowBlur);
    expect(layer?.shadowOffsetX).toBe(TEXT_LAYER_DEFAULTS.shadowOffsetX);
    expect(layer?.shadowOffsetY).toBe(TEXT_LAYER_DEFAULTS.shadowOffsetY);
    expect(layer?.shadowOpacity).toBe(TEXT_LAYER_DEFAULTS.shadowOpacity);
  });

  it('keeps drafts saved before outline and shadow existed readable', () => {
    // The exact shape a document written by the previous version has: only the
    // original ten fields, no outline / shadow keys at all.
    const legacy = restoreTextLayer({
      id: 'layer-old',
      kind: 'text',
      text: 'Summer',
      x: 120,
      y: 260,
      width: 400,
      fontSize: 48,
      fontFamily: 'Arial',
      fill: '#111111',
      fontStyle: 'bold',
      align: 'left',
      scale: 1,
      rotation: 0,
    });

    expect(legacy).not.toBeNull();
    expect(legacy?.text).toBe('Summer');
    expect(legacy?.fill).toBe('#111111');
    expect(legacy?.fontStyle).toBe('bold');
    // And the new options come back switched off rather than undefined.
    expect(legacy?.strokeWidth).toBe(0);
    expect(legacy?.shadowBlur).toBe(0);
    expect(legacy?.shadowOpacity).toBe(TEXT_LAYER_DEFAULTS.shadowOpacity);
  });

  it('rejects unparsable values instead of letting them reach the canvas', () => {
    const layer = restoreTextLayer({
      id: 'layer-t',
      text: 42,
      fontSize: -8,
      fontFamily: '',
      fill: '',
      scale: 0,
      rotation: 'nope',
      align: 'justify',
      fontStyle: 'italic',
    });

    expect(layer?.text).toBe(TEXT_LAYER_DEFAULTS.text);
    expect(layer?.fontSize).toBe(TEXT_LAYER_DEFAULTS.fontSize);
    expect(layer?.fontFamily).toBe(TEXT_LAYER_DEFAULTS.fontFamily);
    expect(layer?.fill).toBe(TEXT_LAYER_DEFAULTS.fill);
    expect(layer?.scale).toBe(1);
    expect(layer?.rotation).toBe(0);
    expect(layer?.align).toBe('center');
    expect(layer?.fontStyle).toBe('normal');
  });

  it('refuses a stored layer without an id', () => {
    expect(restoreTextLayer({ kind: 'text' })).toBeNull();
    expect(restoreTextLayer({ id: '', kind: 'text' })).toBeNull();
  });

  it('validates stored layers by kind', () => {
    expect(restoreStoredLayer(null)).toBeNull();
    expect(restoreStoredLayer('nope')).toBeNull();
    expect(restoreStoredLayer({ id: 'x' })).toBeNull();
    expect(restoreStoredLayer({ kind: 'text' })).toBeNull();
    // A watermark must never come back as a document layer.
    expect(restoreStoredLayer({ id: 'x', kind: 'watermark' })).toBeNull();
    // A picture without a material cannot be resolved.
    expect(restoreStoredLayer({ id: 'x', kind: 'original' })).toBeNull();

    expect(restoreStoredLayer({ id: 'x', kind: 'original', materialId: 'm' })?.kind).toBe('original');
    expect(restoreStoredLayer({ id: 'x', kind: 'cutout', materialId: 'm' })?.kind).toBe('cutout');
    expect(restoreStoredLayer({ id: 'x', kind: 'text' })?.kind).toBe('text');
  });

  it('keeps text layers when their material is long gone', () => {
    const kept = makeImageLayer('layer-keep');
    const dropped = makeImageLayer('layer-drop', { materialId: 'material-missing' });
    const text = createTextLayer();
    const layers: EditorLayer[] = [kept, text, dropped];

    const result = keepLayerWithMaterials(layers, new Set([kept.materialId]));

    expect(result.map((layer) => layer.id)).toEqual([kept.id, text.id]);
  });

  it('round-trips a mixed document through JSON in the original order', () => {
    const first = makeImageLayer('layer-a');
    const text = createTextLayer();
    const second = makeImageLayer('layer-b', { kind: 'cutout' });

    const stored = JSON.parse(JSON.stringify({ layers: [first, text, second] })) as {
      layers: unknown[];
    };
    const restored = stored.layers
      .map(restoreStoredLayer)
      .filter((layer): layer is EditorLayer => layer !== null);

    expect(restored.map((layer) => layer.id)).toEqual([first.id, text.id, second.id]);
    expect(restored.map((layer) => layer.kind)).toEqual(['original', 'text', 'cutout']);
    expect(restored[1]).toEqual(text);
  });

  it('survives a reload even when the stored document is partially written', () => {
    const stored = {
      layers: [null, { id: 'a' }, { id: 'b', kind: 'text', text: 'Summer' }, 7],
    };

    const restored = stored.layers
      .map(restoreStoredLayer)
      .filter((layer): layer is EditorLayer => layer !== null);

    expect(restored).toHaveLength(1);
    expect(restored[0]?.id).toBe('b');
    expect((restored[0] as TextLayer).text).toBe('Summer');
  });
});

describe('text outline and shadow', () => {
  it('commits an outline in one step and undoes it back to none', () => {
    const text = createTextLayer();
    let state = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: text }]);
    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId: text.id,
      patch: { stroke: '#000000', strokeWidth: 6 },
    });

    expect(textLayerAt(state, text.id).stroke).toBe('#000000');
    expect(textLayerAt(state, text.id).strokeWidth).toBe(6);

    state = editorReducer(state, { type: 'UNDO' });
    expect(textLayerAt(state, text.id).stroke).toBe(TEXT_LAYER_DEFAULTS.stroke);
    expect(textLayerAt(state, text.id).strokeWidth).toBe(0);
  });

  it('commits a shadow, undoes it, and redoes it', () => {
    const text = createTextLayer();
    let state = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: text }]);
    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId: text.id,
      patch: {
        shadowColor: '#123456',
        shadowBlur: 20,
        shadowOffsetX: 4,
        shadowOffsetY: -8,
        shadowOpacity: 0.4,
      },
    });

    const shaded = textLayerAt(state, text.id);
    expect(shaded.shadowColor).toBe('#123456');
    expect(shaded.shadowBlur).toBe(20);
    expect(shaded.shadowOffsetX).toBe(4);
    expect(shaded.shadowOffsetY).toBe(-8);
    expect(shaded.shadowOpacity).toBe(0.4);

    state = editorReducer(state, { type: 'UNDO' });
    expect(textLayerAt(state, text.id).shadowBlur).toBe(0);

    state = editorReducer(state, { type: 'REDO' });
    expect(textLayerAt(state, text.id).shadowBlur).toBe(20);
    expect(textLayerAt(state, text.id).shadowOffsetY).toBe(-8);
  });

  it('records one history step per preset click, not one per field', () => {
    const text = createTextLayer();
    let state = reduce(createEditorState(), [{ type: 'ADD_LAYER', layer: text }]);
    const before = state.history.past.length;

    // A preset is a multi-field patch, exactly like the panel sends it.
    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId: text.id,
      patch: { shadowColor: '#000000', shadowBlur: 8, shadowOffsetX: 0, shadowOffsetY: 6, shadowOpacity: 0.5 },
    });

    expect(state.history.past.length).toBe(before + 1);
  });

  it('survives a document round-trip with the outline and shadow intact', () => {
    const text: TextLayer = {
      ...createTextLayer(),
      stroke: '#ffffff',
      strokeWidth: 8,
      shadowColor: '#000000',
      shadowBlur: 18,
      shadowOffsetX: 0,
      shadowOffsetY: 10,
      shadowOpacity: 0.65,
    };

    const stored = JSON.parse(JSON.stringify({ layers: [text] })) as { layers: unknown[] };
    const restored = restoreStoredLayer(stored.layers[0]);

    expect(restored).toEqual(text);
  });
});

describe('estimateTextHeight', () => {
  it('counts one line per newline', () => {
    expect(estimateTextHeight({ text: 'Summer', fontSize: 48 })).toBe(48);
    expect(estimateTextHeight({ text: 'SUMMER\nSALE', fontSize: 48 })).toBe(96);
  });

  it('counts an empty text as a single line', () => {
    expect(estimateTextHeight({ text: '', fontSize: 24 })).toBe(24);
  });
});
