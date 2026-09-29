/**
 * Closing the editor tab, from the service worker side.
 *
 * The editor normally closes itself: `window.close()` works because that page
 * was opened with `chrome.tabs.create`. This module exists for the case where
 * the close is silently ignored — an ignored close is indistinguishable from
 * "the feature does not work", and the tab would just sit there forever.
 *
 * A tab id is deliberately never accepted from the caller. The editor sends its
 * SESSION id and the tab is located by matching URLs, so the worst a wrong or
 * stale id can do is close nothing; it can never take out the product page or a
 * neighbouring tab.
 */

/** The subset of `chrome.tabs.Tab` the matching logic needs (keeps it testable). */
export interface EditorTabLike {
  id?: number;
  url?: string;
}

/** Query parameter the editor URL carries its session in. */
const SESSION_PARAM = 'session';

/**
 * The editor page's URL prefix, e.g. `chrome-extension://<id>/editor/index.html`.
 *
 * Read from the runtime rather than hard-coded, so a moved editor page cannot
 * leave this matching a URL that no longer exists.
 */
export function editorUrlPrefix(): string {
  return chrome.runtime.getURL('editor/index.html');
}

function sessionIdOf(url: string): string | null {
  try {
    return new URL(url).searchParams.get(SESSION_PARAM);
  } catch {
    // Not a URL this environment can parse — never a match.
    return null;
  }
}

/**
 * Tab ids showing the editor for ONE session.
 *
 * Pure, so it is unit-tested without a browser. Every condition earns its keep:
 * the empty-session guard stops a caller that failed to read `?session=` from
 * matching every editor tab ever opened, and the URL-prefix check keeps a
 * product page out even if its own query string happens to contain `session=…`.
 */
export function editorTabIdsFor(
  tabs: readonly EditorTabLike[],
  sessionId: string,
  urlPrefix: string,
): number[] {
  if (!sessionId) return [];
  const ids: number[] = [];
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    if (typeof tab.url !== 'string' || !tab.url.startsWith(urlPrefix)) continue;
    // A bare prefix test is not enough: `…/editor/index.html.bak?session=x` also
    // starts with it. The URL has to CONTINUE at the prefix boundary, with a
    // query or a fragment.
    const rest = tab.url.slice(urlPrefix.length);
    if (rest !== '' && rest[0] !== '?' && rest[0] !== '#') continue;
    if (sessionIdOf(tab.url) !== sessionId) continue;
    ids.push(tab.id);
  }
  return ids;
}

/**
 * Close every editor tab belonging to `sessionId`.
 *
 * Returns how many were closed. A tab that disappears between the query and the
 * removal is not an error — the goal is "this tab is gone", not "I removed it".
 * Never throws: the caller has already reported success to the user, and there
 * is nothing useful to tell them about a tab that refused to close.
 */
export async function closeEditorTabs(sessionId: string): Promise<number> {
  if (!sessionId) return 0;

  let tabs: EditorTabLike[];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return 0;
  }

  const ids = editorTabIdsFor(tabs, sessionId, editorUrlPrefix());
  await Promise.all(ids.map((id) => chrome.tabs.remove(id).catch(() => undefined)));
  return ids.length;
}
