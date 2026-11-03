/**
 * Canvas background colour as a document property.
 *
 * The background is not a layer: it must not appear in the layer list, must not
 * be selectable, and must not be counted by the layout planner. But it *is* part
 * of what the user sees and exports, so it lives in `EditorDocument` rather than
 * in `EditorState.showWhiteBackground` (which only toggles the on-screen
 * checkerboard preview).
 *
 * Kept in its own module because three readers need the same default and the same
 * validation: the stage (preview), the exporter (PNG) and the change history.
 */
import { DEFAULT_DOCUMENT_BACKGROUND } from '../shared/constants';
import type { EditorDocument } from '../shared/types';

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Coerce anything that came from JSON, storage or a colour input into `#rrggbb`.
 *
 * Accepts `#abc` (expanded), `#aabbcc`, and the same without `#` — the browser's
 * `<input type="color">` always emits the long form, but a hand-written template
 * or an older document may carry the short one. Everything else falls back to
 * white, which is both the previous behaviour and what the marketplace expects.
 */
export function normalizeBackgroundColor(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_DOCUMENT_BACKGROUND;
  const raw = value.trim();
  if (!raw) return DEFAULT_DOCUMENT_BACKGROUND;
  const withHash = raw.startsWith('#') ? raw : `#${raw}`;
  if (!HEX_PATTERN.test(withHash)) return DEFAULT_DOCUMENT_BACKGROUND;
  const body = withHash.slice(1).toLowerCase();
  if (body.length === 3) {
    return `#${body[0]}${body[0]}${body[1]}${body[1]}${body[2]}${body[2]}`;
  }
  return `#${body}`;
}

/** Effective background of a document; `undefined` means "the old white". */
export function backgroundOf(document: EditorDocument | null | undefined): string {
  return normalizeBackgroundColor(document?.background);
}

/** True when the document carries a non-default background worth persisting. */
export function hasCustomBackground(document: EditorDocument | null | undefined): boolean {
  if (!document || document.background === undefined) return false;
  return normalizeBackgroundColor(document.background) !== DEFAULT_DOCUMENT_BACKGROUND;
}
