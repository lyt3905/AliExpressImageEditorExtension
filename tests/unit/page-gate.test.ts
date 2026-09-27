/**
 * The page gate decides whether a toolbar click is allowed to start a scan.
 *
 * It has no DOM dependency, so it runs in the default (node) environment.
 * These cases exist because the previous implementation collapsed five very
 * different situations into one message ("请先在 AliExpress 商品编辑页点击插件
 * 图标"), which pointed the user at the wrong problem whenever the real cause was
 * a non-web tab, the extension's own editor tab, or a locale site we do not
 * support.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluatePageGate,
  isSupportedPageUrl,
  SELLER_HOST_PATTERN,
  SUPPORTED_PAGE_DESCRIPTION,
} from '../../src/shared/page-gate';

/** Convenience: reject or fail loudly. */
function rejection(rawUrl: string | null | undefined) {
  const result = evaluatePageGate(rawUrl);
  if (result.ok) throw new Error(`expected rejection for ${String(rawUrl)}`);
  return result;
}

describe('evaluatePageGate / accepted pages', () => {
  const accepted = [
    'https://www.aliexpress.com/',
    'https://aliexpress.com/',
    'https://seller.aliexpress.com/product/publish.htm',
    'https://csp.aliexpress.com/apps/product/publish',
    'https://www.aliexpress.com/item/100500.html?spm=a2g0o',
    // Case must not matter.
    'https://WWW.AliExpress.COM/product/edit',
    // No trailing slash on a bare origin — the old `aliexpress\.com\/` pattern
    // rejected this shape.
    'https://www.aliexpress.com',
    // http is accepted by the gate; the adapter applies the stricter path check.
    'http://www.aliexpress.com/product/publish.htm',
  ];

  for (const url of accepted) {
    it(`accepts ${url}`, () => {
      const result = evaluatePageGate(url);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.host.endsWith('aliexpress.com')).toBe(true);
      }
      expect(isSupportedPageUrl(url)).toBe(true);
    });
  }

  it('tolerates surrounding whitespace', () => {
    expect(isSupportedPageUrl('  https://www.aliexpress.com/  ')).toBe(true);
  });
});

describe('evaluatePageGate / no URL at all', () => {
  for (const raw of [undefined, null, '', '   ']) {
    it(`reports NO_TAB_URL for ${JSON.stringify(raw)}`, () => {
      const result = rejection(raw);
      expect(result.reason).toBe('NO_TAB_URL');
      expect(result.rawUrl).toBe('');
      // Must not blame the user for being on the wrong site — we never saw a site.
      expect(result.message).toContain('读取不到');
      expect(result.message).toContain(SUPPORTED_PAGE_DESCRIPTION);
    });
  }
});

describe('evaluatePageGate / non-web tabs', () => {
  const cases: Array<[string, string]> = [
    ['chrome://extensions/', 'chrome'],
    ['edge://settings/', 'edge'],
    ['about:blank', 'about'],
    ['file:///C:/tmp/gallery.html', 'file'],
    ['devtools://devtools/bundled/inspector.html', 'devtools'],
  ];

  for (const [url, scheme] of cases) {
    it(`reports NOT_A_WEB_PAGE for a ${scheme} tab`, () => {
      const result = rejection(url);
      expect(result.reason).toBe('NOT_A_WEB_PAGE');
      expect(result.rawUrl).toBe(url);
      expect(result.message).toContain(`${scheme}://`);
    });
  }

  it('reports NOT_A_WEB_PAGE for an unparseable value', () => {
    const result = rejection('not a url');
    expect(result.reason).toBe('NOT_A_WEB_PAGE');
    expect(result.message).toContain('not a url');
  });
});

describe('evaluatePageGate / the extension\'s own pages', () => {
  it('calls out the editor tab explicitly instead of blaming the site', () => {
    const url = 'chrome-extension://hfbbblcacchfifidmeolipcmnpapnimd/editor/index.html?session=sess-1';
    const result = rejection(url);
    expect(result.reason).toBe('EXTENSION_PAGE');
    expect(result.host).toBe('hfbbblcacchfifidmeolipcmnpapnimd');
    expect(result.message).toContain('插件自己的页面');
  });

  it('covers the options page too', () => {
    expect(rejection('chrome-extension://abc/options/index.html').reason).toBe('EXTENSION_PAGE');
  });
});

describe('evaluatePageGate / AliExpress sites we do not support', () => {
  const locales = ['https://www.aliexpress.us/item/1.html', 'https://www.aliexpress.ru/', 'https://aliexpress.es/'];

  for (const url of locales) {
    it(`names the locale host in the message for ${url}`, () => {
      const result = rejection(url);
      expect(result.reason).toBe('OTHER_LOCALE_HOST');
      expect(result.message).toContain(result.host);
      expect(result.message).toContain('其他地区站点');
    });
  }
});

describe('evaluatePageGate / unrelated sites', () => {
  const hosts = [
    'https://www.google.com/',
    'https://taobao.com/',
    // Lookalikes must never pass: the host pattern is anchored on a dot.
    'https://evil-aliexpress.com/',
    'https://notaliexpress.com/',
    'https://www.aliexpress.com.evil.com/',
    'https://aliexpress.com.cn/',
  ];

  for (const url of hosts) {
    it(`rejects ${url}`, () => {
      const result = rejection(url);
      expect(result.reason).toBe('NOT_ALIEXPRESS');
      expect(result.message).toContain(result.host);
      expect(isSupportedPageUrl(url)).toBe(false);
    });
  }
});

describe('SELLER_HOST_PATTERN', () => {
  it('matches the seller console and its subdomains only', () => {
    expect(SELLER_HOST_PATTERN.test('aliexpress.com')).toBe(true);
    expect(SELLER_HOST_PATTERN.test('seller.aliexpress.com')).toBe(true);
    expect(SELLER_HOST_PATTERN.test('aliexpress.us')).toBe(false);
    expect(SELLER_HOST_PATTERN.test('fakealiexpress.com')).toBe(false);
    expect(SELLER_HOST_PATTERN.test('aliexpress.com.hk')).toBe(false);
  });
});
