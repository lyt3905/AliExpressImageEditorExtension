/**
 * Undo/redo history: simple bounded snapshot stack.
 *
 * A snapshot is only pushed for committed edits (add / delete / reorder /
 * dragEnd / transformEnd / clear) — never during dragmove or transform.
 */

import { MAX_HISTORY } from '../../shared/constants';
import type { EditorDocument } from '../../shared/types';

export interface HistoryState {
  past: EditorDocument[];
  present: EditorDocument;
  future: EditorDocument[];
}

export function createHistory(present: EditorDocument): HistoryState {
  return { past: [], present, future: [] };
}

/** Push a committed document. Identical documents are ignored. */
export function pushHistory(history: HistoryState, next: EditorDocument, limit = MAX_HISTORY): HistoryState {
  if (next === history.present) return history;
  const past = [...history.past, history.present];
  const trimmed = past.length > limit ? past.slice(past.length - limit) : past;
  return { past: trimmed, present: next, future: [] };
}

/** Replace the present without touching history (live drag/transform updates). */
export function replacePresent(history: HistoryState, next: EditorDocument): HistoryState {
  if (next === history.present) return history;
  return { past: history.past, present: next, future: history.future };
}

export function canUndo(history: HistoryState): boolean {
  return history.past.length > 0;
}

export function canRedo(history: HistoryState): boolean {
  return history.future.length > 0;
}

export function undo(history: HistoryState): HistoryState {
  if (!canUndo(history)) return history;
  const previous = history.past[history.past.length - 1] as EditorDocument;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: HistoryState): HistoryState {
  if (!canRedo(history)) return history;
  const [next, ...rest] = history.future as [EditorDocument, ...EditorDocument[]];
  return { past: [...history.past, history.present], present: next, future: rest };
}
