import { describe, expect, it } from 'vitest';
import { CANVAS_SIZE } from '../../src/shared/constants';
import type { PlateLayer } from '../../src/shared/types';
import {
  createEditorState,
  createPlateLayer,
  editorReducer,
  keepLayerWithMaterials,
  restorePlateLayer,
  restoreStoredLayer,
} from '../../src/editor/state/editor-reducer';
import { canUndo } from '../../src/editor/state/history';

describe('createPlateLayer', () => {
  it('centres the plate and writes every field explicitly', () => {
    const plate = createPlateLayer({ width: 380, height: 510, fill: '#F5F5F5', cornerRadius: 24 });
    expect(plate).toMatchObject({
      kind: 'plate',
      x: CANVAS_SIZE / 2,
      y: CANVAS_SIZE / 2,
      width: 380,
      height: 510,
      fill: '#F5F5F5',
      cornerRadius: 24,
      scale: 1,
      rotation: 0,
      flipX: false,
      flipY: false,
    });
  });

  it('never produces an unselectable zero-size plate', () => {
    const plate = createPlateLayer({ width: 0, height: -5, fill: '#fff', cornerRadius: -3 });
    expect(plate.width).toBe(1);
    expect(plate.height).toBe(1);
    expect(plate.cornerRadius).toBe(0);
  });

  it('gives each plate a unique id', () => {
    const a = createPlateLayer({ width: 10, height: 10, fill: '#fff', cornerRadius: 0 });
    const b = createPlateLayer({ width: 10, height: 10, fill: '#fff', cornerRadius: 0 });
    expect(a.id).not.toBe(b.id);
  });
});

describe('restorePlateLayer', () => {
  it('round-trips a freshly created plate', () => {
    const plate = createPlateLayer({
      width: 380,
      height: 510,
      fill: '#EEEEEE',
      cornerRadius: 12,
      x: 575,
      y: 280,
      scale: 0.8,
      rotation: 5,
    });
    expect(restorePlateLayer(plate as unknown as Record<string, unknown>)).toEqual(plate);
  });

  it('rejects a layer without an id', () => {
    expect(restorePlateLayer({ kind: 'plate', width: 10, height: 10 })).toBeNull();
  });

  it('repairs corrupt fields instead of refusing to load', () => {
    const restored = restorePlateLayer({
      id: 'plate-1',
      width: 0,
      height: Number.NaN,
      fill: 42,
      cornerRadius: -10,
      scale: -2,
      rotation: 'x',
    });
    expect(restored).not.toBeNull();
    expect(restored!.width).toBeGreaterThan(0);
    expect(restored!.height).toBeGreaterThan(0);
    expect(restored!.cornerRadius).toBe(0);
    expect(restored!.scale).toBeGreaterThan(0);
    expect(restored!.rotation).toBe(0);
    // A non-string colour falls back; a nonsense STRING is passed through, exactly
    // like text layers do (`pickColor` only checks "non-empty string"). Konva ignores
    // an unparseable fill, and the layer stays visible in the layer list, so this is
    // recoverable — stricter validation here would diverge from the text path.
    expect(restored!.fill).toBe('#F5F5F5');
  });

  it('passes an unusual colour string through, matching the text-layer rule', () => {
    expect(
      restorePlateLayer({ id: 'p', width: 10, height: 10, fill: 'not-a-colour', cornerRadius: 0 })!.fill,
    ).toBe('not-a-colour');
  });

  it('defaults the mirror flags to false for documents written before them', () => {
    const restored = restorePlateLayer({ id: 'plate-1', width: 10, height: 10, fill: '#fff', cornerRadius: 0 });
    expect(restored!.flipX).toBe(false);
    expect(restored!.flipY).toBe(false);
  });
});

describe('restoreStoredLayer', () => {
  it('routes plate documents to the plate path', () => {
    const restored = restoreStoredLayer({
      id: 'plate-1',
      kind: 'plate',
      x: 100,
      y: 100,
      width: 50,
      height: 60,
      fill: '#123456',
      cornerRadius: 4,
      scale: 1,
      rotation: 0,
    });
    expect(restored?.kind).toBe('plate');
    expect((restored as PlateLayer).fill).toBe('#123456');
  });
});

describe('keepLayerWithMaterials', () => {
  it('keeps plates even though they have no material', () => {
    // Without this, every editor reload would silently delete the backdrop.
    const plate = createPlateLayer({ width: 10, height: 10, fill: '#fff', cornerRadius: 0 });
    const kept = keepLayerWithMaterials([plate], new Set<string>());
    expect(kept).toHaveLength(1);
    expect(kept[0].id).toBe(plate.id);
  });

  it('still drops pictures whose material is gone', () => {
    const picture = {
      id: 'img-1',
      kind: 'cutout' as const,
      materialId: 'gone',
      blobId: 'blob-gone',
      sourceWidth: 10,
      sourceHeight: 10,
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
    };
    expect(keepLayerWithMaterials([picture], new Set<string>())).toHaveLength(0);
  });
});

describe('APPLY_PLAN', () => {
  it('replaces the document in a single history entry', () => {
    const plate = createPlateLayer({ width: 100, height: 100, fill: '#fff', cornerRadius: 0 });
    const initial = createEditorState();
    const applied = editorReducer(initial, { type: 'APPLY_PLAN', layers: [plate] });
    expect(applied.history.present.layers).toHaveLength(1);
    expect(applied.selectedLayerId).toBeNull();
    expect(canUndo(applied.history)).toBe(true);
  });

  it('undoes the whole generated layout in one step', () => {
    const plate = createPlateLayer({ width: 100, height: 100, fill: '#fff', cornerRadius: 0 });
    const applied = editorReducer(createEditorState(), { type: 'APPLY_PLAN', layers: [plate] });
    const undone = editorReducer(applied, { type: 'UNDO' });
    expect(undone.history.present.layers).toEqual([]);
  });

  it('ignores an empty plan rather than pushing a no-op history entry', () => {
    const initial = createEditorState();
    expect(editorReducer(initial, { type: 'APPLY_PLAN', layers: [] })).toBe(initial);
  });

  it('pre-selects the layer the caller names', () => {
    // A composed canvas looks like a restored one; leaving nothing selected sent the
    // first drag to whatever was under the pointer — usually the backdrop plate, which
    // moves invisibly behind the hero and reads as "拖不动".
    const plate = createPlateLayer({ width: 100, height: 100, fill: '#fff', cornerRadius: 0 });
    const applied = editorReducer(createEditorState(), {
      type: 'APPLY_PLAN',
      layers: [plate],
      selectLayerId: plate.id,
    });
    expect(applied.selectedLayerId).toBe(plate.id);
  });

  it('never selects a layer that is not in the plan', () => {
    const plate = createPlateLayer({ width: 100, height: 100, fill: '#fff', cornerRadius: 0 });
    const applied = editorReducer(createEditorState(), {
      type: 'APPLY_PLAN',
      layers: [plate],
      selectLayerId: 'layer-from-another-document',
    });
    expect(applied.selectedLayerId).toBeNull();
  });
});
