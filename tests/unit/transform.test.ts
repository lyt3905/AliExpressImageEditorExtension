import { describe, expect, it } from 'vitest';
import { ROTATE_SNAP_DEG, ROTATE_STEP_DEG } from '../../src/shared/constants';
import type { ImageLayer } from '../../src/shared/types';
import {
  createEditorState,
  editorReducer,
  restoreStoredLayer,
  type EditorState,
} from '../../src/editor/state/editor-reducer';
import {
  axisScale,
  normalizeRotation,
  rotationCommit,
  shortestDelta,
  snapRotation,
  splitSignedScale,
  transformPatch,
} from '../../src/editor/state/transform';

function makeLayer(patch: Partial<ImageLayer> = {}): ImageLayer {
  return {
    id: 'layer-1',
    materialId: 'material-1',
    blobId: 'blob-1',
    sourceWidth: 1000,
    sourceHeight: 500,
    x: 400,
    y: 400,
    scale: 0.4,
    rotation: 0,
    kind: 'cutout',
    ...patch,
  };
}

describe('normalizeRotation', () => {
  it('wraps any angle into [0, 360)', () => {
    expect(normalizeRotation(0)).toBe(0);
    expect(normalizeRotation(90)).toBe(90);
    expect(normalizeRotation(360)).toBe(0);
    expect(normalizeRotation(450)).toBe(90);
    expect(normalizeRotation(-90)).toBe(270);
    expect(normalizeRotation(-450)).toBe(270);
    expect(normalizeRotation(359.5)).toBeCloseTo(359.5, 6);
  });

  it('falls back to 0 for a non-finite angle instead of poisoning the layer', () => {
    expect(normalizeRotation(Number.NaN)).toBe(0);
    expect(normalizeRotation(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('shortestDelta', () => {
  it('keeps a small sweep small', () => {
    expect(shortestDelta(0)).toBe(0);
    expect(shortestDelta(10)).toBe(10);
    expect(shortestDelta(-10)).toBe(-10);
  });

  it('wraps past ±180 so a drag never turns the long way round', () => {
    expect(shortestDelta(180)).toBe(180);
    expect(shortestDelta(-180)).toBe(180);
    expect(shortestDelta(359)).toBe(-1);
    expect(shortestDelta(-359)).toBe(1);
    expect(shortestDelta(540)).toBe(180);
  });

  it('accumulates a full turn instead of collapsing it to zero', () => {
    // Sweeping clockwise 0 -> 90 -> 180 -> 270 -> 359 in 90° steps.
    let previous = 0;
    let total = 0;
    for (const angle of [90, 180, 270, 359]) {
      total += shortestDelta(angle - previous);
      previous = angle;
    }
    expect(total).toBe(359);
  });

  it('is 0 for a non-finite step', () => {
    expect(shortestDelta(Number.NaN)).toBe(0);
  });
});

describe('snapRotation', () => {
  it('lands on the nearest multiple of the step', () => {
    expect(snapRotation(7)).toBe(0);
    expect(snapRotation(8)).toBe(15);
    expect(snapRotation(22)).toBe(15);
    expect(snapRotation(23)).toBe(30);
    expect(snapRotation(-8)).toBe(345);
  });

  it('wraps a snapped full turn back to 0', () => {
    expect(snapRotation(350)).toBe(345);
    expect(snapRotation(354)).toBe(0);
    expect(snapRotation(359)).toBe(0);
  });

  it('falls back to a plain wrap for a useless step', () => {
    expect(snapRotation(47, 0)).toBe(47);
    expect(snapRotation(47, Number.NaN)).toBe(47);
  });

  it('defaults to the shared snap constant', () => {
    expect(ROTATE_SNAP_DEG).toBe(15);
  });
});

describe('transformPatch', () => {
  it('uses the shared 90° step', () => {
    expect(ROTATE_STEP_DEG).toBe(90);
  });

  it('ADDS a quarter turn instead of snapping to a fixed angle', () => {
    expect(transformPatch({ rotation: 0 }, 'rotate-cw')).toEqual({ rotation: 90 });
    expect(transformPatch({ rotation: 30 }, 'rotate-cw')).toEqual({ rotation: 120 });
    expect(transformPatch({ rotation: 270 }, 'rotate-cw')).toEqual({ rotation: 0 });
    expect(transformPatch({ rotation: 0 }, 'rotate-ccw')).toEqual({ rotation: 270 });
    expect(transformPatch({ rotation: 90 }, 'rotate-ccw')).toEqual({ rotation: 0 });
  });

  it('toggles each mirror independently', () => {
    expect(transformPatch({ rotation: 0 }, 'flip-x')).toEqual({ flipX: true });
    expect(transformPatch({ rotation: 0, flipX: true }, 'flip-x')).toEqual({ flipX: false });
    expect(transformPatch({ rotation: 0 }, 'flip-y')).toEqual({ flipY: true });
    // A stored document from before mirroring existed has no flag at all;
    // `undefined` must read as "not mirrored", not as "already mirrored".
    expect(transformPatch({ rotation: 0, flipX: undefined }, 'flip-x')).toEqual({ flipX: true });
    // And the two axes never touch each other.
    expect(transformPatch({ rotation: 0, flipX: true }, 'flip-y')).toEqual({ flipY: true });
  });
});

describe('rotationCommit', () => {
  it('reports "nothing to do" instead of pushing an empty undo step', () => {
    expect(rotationCommit({ rotation: 0 }, 0)).toBeNull();
    expect(rotationCommit({ rotation: 0 }, 360)).toBeNull();
    expect(rotationCommit({ rotation: 90 }, -270)).toBeNull();
  });

  it('wraps the angle it commits', () => {
    expect(rotationCommit({ rotation: 0 }, 450)).toEqual({ rotation: 90 });
    expect(rotationCommit({ rotation: 0 }, -90)).toEqual({ rotation: 270 });
  });
});

describe('axisScale / splitSignedScale', () => {
  it('applies the mirror as a sign on one axis only', () => {
    expect(axisScale({ scale: 0.5 }, 'x')).toBe(0.5);
    expect(axisScale({ scale: 0.5, flipX: true }, 'x')).toBe(-0.5);
    expect(axisScale({ scale: 0.5, flipX: true }, 'y')).toBe(0.5);
    expect(axisScale({ scale: 0.5, flipY: true }, 'y')).toBe(-0.5);
    expect(axisScale({ scale: 0.5, flipY: true }, 'x')).toBe(0.5);
  });

  it('splits a signed scale back into magnitude + flags', () => {
    expect(splitSignedScale(0.4, 0.4)).toEqual({ scale: 0.4, flipX: false, flipY: false });
    expect(splitSignedScale(-0.4, 0.4)).toEqual({ scale: 0.4, flipX: true, flipY: false });
    expect(splitSignedScale(0.4, -0.4)).toEqual({ scale: 0.4, flipX: false, flipY: true });
    expect(splitSignedScale(-0.4, -0.4)).toEqual({ scale: 0.4, flipX: true, flipY: true });
  });

  it('never yields a zero or negative scale for a collapsed node', () => {
    expect(splitSignedScale(0, 0)).toEqual({ scale: 1, flipX: false, flipY: false });
  });

  it('is the exact inverse of axisScale', () => {
    // The invariant that keeps a mirrored layer from un-mirroring itself every
    // time the transformer reports a resize.
    for (const flipX of [false, true]) {
      for (const flipY of [false, true]) {
        const fields = { scale: 0.37, flipX, flipY };
        const back = splitSignedScale(axisScale(fields, 'x'), axisScale(fields, 'y'));
        expect(back.scale).toBeCloseTo(0.37, 6);
        expect(back.flipX).toBe(flipX);
        expect(back.flipY).toBe(flipY);
      }
    }
  });
});

describe('editorReducer + transformPatch', () => {
  it('records one history step per 90° turn, so undo walks back a quarter at a time', () => {
    let state: EditorState = editorReducer(createEditorState(), {
      type: 'ADD_LAYER',
      layer: makeLayer({ rotation: 0 }),
    });

    const turn = () => {
      const layer = state.history.present.layers[0] as ImageLayer;
      state = editorReducer(state, {
        type: 'COMMIT_LAYER',
        layerId: layer.id,
        patch: transformPatch(layer, 'rotate-cw'),
      });
    };

    turn();
    turn();
    expect((state.history.present.layers[0] as ImageLayer).rotation).toBe(180);
    // add + two turns.
    expect(state.history.past).toHaveLength(3);

    state = editorReducer(state, { type: 'UNDO' });
    expect((state.history.present.layers[0] as ImageLayer).rotation).toBe(90);
  });

  it('keeps a mirrored layer mirrored through a resize', () => {
    let state: EditorState = editorReducer(createEditorState(), { type: 'ADD_LAYER', layer: makeLayer() });
    const layerId = (state.history.present.layers[0] as ImageLayer).id;

    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId,
      patch: transformPatch({ rotation: 0 }, 'flip-x'),
    });
    expect((state.history.present.layers[0] as ImageLayer).flipX).toBe(true);

    // What the transformer reports after the user drags a handle on a mirrored
    // layer: a NEGATIVE scale. The document must store magnitude + flag.
    const fields = { scale: 0.25, flipX: true };
    const node = splitSignedScale(axisScale(fields, 'x'), axisScale(fields, 'y'));
    state = editorReducer(state, {
      type: 'COMMIT_LAYER',
      layerId,
      patch: { scale: node.scale, flipX: node.flipX, flipY: node.flipY },
    });

    const resized = state.history.present.layers[0] as ImageLayer;
    expect(resized.scale).toBe(0.25);
    expect(resized.flipX).toBe(true);
    expect(resized.flipY).toBe(false);
  });
});

describe('stored documents', () => {
  it('reads mirror flags back, and treats their absence as "not mirrored"', () => {
    const mirrored = restoreStoredLayer({ id: 't1', kind: 'text', flipX: true });
    expect(mirrored?.flipX).toBe(true);
    expect(mirrored?.flipY).toBe(false);

    const legacy = restoreStoredLayer({ id: 't2', kind: 'text' });
    expect(legacy?.flipX).toBe(false);
    expect(legacy?.flipY).toBe(false);
  });

  it('keeps the flags on a picture layer, which is stored as-is', () => {
    const restored = restoreStoredLayer({
      id: 'p1',
      kind: 'cutout',
      materialId: 'm1',
      blobId: 'b1',
      sourceWidth: 100,
      sourceHeight: 100,
      x: 400,
      y: 400,
      scale: 1,
      rotation: 90,
      flipX: true,
      flipY: true,
    });
    expect(restored?.rotation).toBe(90);
    expect(restored?.flipX).toBe(true);
    expect(restored?.flipY).toBe(true);
  });
});
