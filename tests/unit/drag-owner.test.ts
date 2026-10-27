import { describe, expect, it } from 'vitest';
import {
  decideDragOwner,
  pointInsideBox,
  type DragOwnerInput,
} from '../../src/editor/state/drag-owner';

/*
  The table below is the user-visible contract of "画布好不好拖". Every row is a
  gesture the seller actually makes on a composed canvas, and every row that
  answers `selection` moves a layer the pointer is NOT on — so the list of
  `selection` rows has to stay short and explainable.

  The default row is the important one: the hero the planner selects after
  composing (`selectionIsExplicit: false`) must not take over. Only a layer the
  user picked by hand gets drag priority — that is what makes a picture whose box
  is covered by another picture movable at all (a cut-out is mostly transparent
  margin, and its box therefore sits on top of whatever is behind it).
*/

function owner(overrides: Partial<DragOwnerInput> = {}): string {
  return decideDragOwner({
    pressedId: 'picture-b',
    pressedIsBackdrop: false,
    selectedId: 'hero',
    pointerInsideSelection: true,
    forceSelection: false,
    selectionIsExplicit: false,
    ...overrides,
  });
}

describe('decideDragOwner', () => {
  it('moves the pressed layer when nothing is selected', () => {
    expect(owner({ selectedId: null })).toBe('pressed');
  });

  it('moves the pressed layer when the press landed on the selection', () => {
    expect(owner({ pressedId: 'hero', selectedId: 'hero' })).toBe('pressed');
  });

  it('moves an overlapping picture even though the hero is auto-selected', () => {
    // The regression that made the canvas feel broken: the hero used to slide
    // whenever a packaging box or a label on top of it was grabbed.
    expect(owner()).toBe('pressed');
  });

  it('moves a label that sits on top of the auto-selected picture', () => {
    expect(owner({ pressedId: 'product-code' })).toBe('pressed');
  });

  it('hands the gesture to a layer the user selected by hand', () => {
    // The occlusion case: the user picked this layer in the panel (or on the
    // canvas), its box is covered by the picture on top, so the press lands on
    // the other one. "I picked this one" wins.
    expect(owner({ selectionIsExplicit: true })).toBe('selection');
    expect(owner({ selectionIsExplicit: true, pressedId: 'product-code' })).toBe('selection');
  });

  it('still moves the pressed layer when the hand-picked selection is elsewhere', () => {
    // Priority is bounded by the selection's own box: a press on the far side of
    // the canvas must not teleport something else.
    expect(owner({ selectionIsExplicit: true, pointerInsideSelection: false })).toBe('pressed');
  });

  it('moves the pressed layer when the pointer is outside the selection box', () => {
    expect(owner({ pointerInsideSelection: false })).toBe('pressed');
    expect(owner({ pointerInsideSelection: false, pressedIsBackdrop: true })).toBe('pressed');
  });

  it('hands a backdrop press inside the selection box to the selection', () => {
    expect(owner({ pressedId: 'plate', pressedIsBackdrop: true })).toBe('selection');
  });

  it('hands anything inside the selection box to the selection while Alt is held', () => {
    expect(owner({ forceSelection: true })).toBe('selection');
    expect(owner({ forceSelection: true, pressedId: 'product-code' })).toBe('selection');
  });

  it('keeps the pressed layer when Alt is held outside the selection box', () => {
    expect(owner({ forceSelection: true, pointerInsideSelection: false })).toBe('pressed');
  });

  it('never hands a press on the empty stage anywhere', () => {
    expect(owner({ pressedId: null })).toBe('pressed');
    expect(owner({ pressedId: null, forceSelection: true })).toBe('pressed');
    expect(owner({ pressedId: null, selectionIsExplicit: true })).toBe('pressed');
  });

  it('keeps the selected layer when it is the backdrop being pressed', () => {
    expect(owner({ pressedId: 'plate', selectedId: 'plate', pressedIsBackdrop: true })).toBe(
      'pressed',
    );
  });

  it('does not need Alt to move a hand-picked layer', () => {
    // Same gesture with and without Alt: the explicit selection already said it.
    expect(owner({ selectionIsExplicit: true })).toBe(
      owner({ selectionIsExplicit: true, forceSelection: true }),
    );
  });
});

describe('pointInsideBox', () => {
  const box = { x: 100, y: 50, width: 200, height: 120 };

  it('accepts the interior and both edges inclusively', () => {
    expect(pointInsideBox(box, { x: 200, y: 110 })).toBe(true);
    expect(pointInsideBox(box, { x: 100, y: 50 })).toBe(true);
    expect(pointInsideBox(box, { x: 300, y: 170 })).toBe(true);
  });

  it('rejects points one pixel outside each edge', () => {
    expect(pointInsideBox(box, { x: 99, y: 110 })).toBe(false);
    expect(pointInsideBox(box, { x: 301, y: 110 })).toBe(false);
    expect(pointInsideBox(box, { x: 200, y: 49 })).toBe(false);
    expect(pointInsideBox(box, { x: 200, y: 171 })).toBe(false);
  });
});
