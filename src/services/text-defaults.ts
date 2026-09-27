/**
 * Remembered text style.
 *
 * A single preference object, not per-layer and not per-session: the point is
 * that the next "添加文字" starts from the style you last used, in this browser
 * and after a restart.
 *
 * - `chrome.storage.local` rather than `session`: a session entry dies with the
 *   browser, which is the opposite of "remembered".
 * - `local` rather than `sync`: `sync` caps writes at 120/minute, and a style
 *   commit fires on every field blur.
 * - Never inside `EditorDocument`: the document describes this picture, this
 *   preference describes the user, and the document is inside the history stack.
 */

import { STORAGE_KEYS } from '../shared/constants';
import { DEFAULT_TEXT_STYLE, sanitizeTextStyle, type TextStyleDefaults } from '../shared/text-style';

/** Stored style, or the factory defaults when nothing is remembered yet. */
export async function loadTextDefaults(): Promise<TextStyleDefaults> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.textDefaults);
    return sanitizeTextStyle(stored?.[STORAGE_KEYS.textDefaults]);
  } catch {
    // A missing or unreadable preference is not an error condition: the editor
    // simply behaves the way it did before this feature existed.
    return { ...DEFAULT_TEXT_STYLE };
  }
}

/**
 * Persist the full style.
 *
 * Deliberately a dumb overwrite instead of a read-modify-write: two quick
 * commits (change the size, then the colour) would otherwise interleave their
 * get/set pairs and the earlier one would win.
 */
export async function saveTextDefaults(next: TextStyleDefaults): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.textDefaults]: sanitizeTextStyle(next) });
  } catch {
    // Non fatal: the style just is not remembered next time.
  }
}

/** Forget the remembered style; the next text layer uses the factory defaults. */
export async function clearTextDefaults(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORAGE_KEYS.textDefaults);
  } catch {
    /* ignore */
  }
}
