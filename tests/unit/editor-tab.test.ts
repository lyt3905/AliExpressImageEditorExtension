import { describe, expect, it } from 'vitest';
import { editorTabIdsFor, type EditorTabLike } from '../../src/background/editor-tab';

/**
 * Matching is the only thing standing between "close my editor" and "close the
 * seller's product page", so every guard gets its own case. The tab ids below
 * are arbitrary but distinct, which makes a wrong match obvious at a glance.
 */
const PREFIX = 'chrome-extension://abcdefghijklmnop/editor/index.html';

function editorTab(id: number, session: string): EditorTabLike {
  return { id, url: `${PREFIX}?session=${session}` };
}

describe('editorTabIdsFor', () => {
  it('matches only the tabs showing that session', () => {
    const tabs = [editorTab(1, 'sess-a'), editorTab(2, 'sess-b'), editorTab(3, 'sess-a')];
    expect(editorTabIdsFor(tabs, 'sess-a', PREFIX)).toEqual([1, 3]);
    expect(editorTabIdsFor(tabs, 'sess-b', PREFIX)).toEqual([2]);
  });

  it('never matches on an empty session id', () => {
    // The editor falls back to `sessionId ?? ''` when the URL has no ?session=.
    // Treating '' as a wildcard would close every editor tab the user has open,
    // including ones belonging to other products.
    const tabs = [editorTab(1, 'sess-a'), editorTab(2, 'sess-b')];
    expect(editorTabIdsFor(tabs, '', PREFIX)).toEqual([]);
  });

  it('ignores other extension pages that merely carry a session parameter', () => {
    const tabs: EditorTabLike[] = [
      { id: 1, url: 'chrome-extension://abcdefghijklmnop/options/index.html?session=sess-a' },
      { id: 2, url: 'chrome-extension://abcdefghijklmnop/editor/index.html.bak?session=sess-a' },
    ];
    expect(editorTabIdsFor(tabs, 'sess-a', PREFIX)).toEqual([]);
  });

  it('ignores the product page even when its own query string says session=', () => {
    const tabs: EditorTabLike[] = [
      { id: 7, url: 'https://seller.aliexpress.com/product/edit.htm?session=sess-a' },
    ];
    expect(editorTabIdsFor(tabs, 'sess-a', PREFIX)).toEqual([]);
  });

  it('accepts extra query parameters around the session', () => {
    const tabs: EditorTabLike[] = [
      { id: 4, url: `${PREFIX}?foo=1&session=sess-a&bar=2` },
      { id: 5, url: `${PREFIX}?session=sess-a` },
    ];
    expect(editorTabIdsFor(tabs, 'sess-a', PREFIX)).toEqual([4, 5]);
  });

  it('skips tabs with no id or an unparseable url', () => {
    const tabs: EditorTabLike[] = [
      { url: `${PREFIX}?session=sess-a` },
      { id: 6, url: 'not a url at all' },
      { id: 8, url: `${PREFIX}?session=sess-a` },
    ];
    expect(editorTabIdsFor(tabs, 'sess-a', PREFIX)).toEqual([8]);
  });

  it('returns nothing for an empty tab list', () => {
    expect(editorTabIdsFor([], 'sess-a', PREFIX)).toEqual([]);
  });
});
