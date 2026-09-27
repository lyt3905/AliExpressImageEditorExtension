// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://seller.aliexpress.com/product/publish.htm"}
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { AliExpressPageAdapter } from '../../src/content/aliexpress-page-adapter';
import {
  collectFromSellerWidget,
  isUsableCandidate,
  isUsableWidgetCandidate,
  readImageSize,
  scanDocument,
} from '../../src/content/image-scanner';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(resolve(here, '../fixtures/aliexpress-page.html'), 'utf-8');

const CDN = 'https://ae-pic-a1.aliexpress-media.com/kf';

/** The five product slots the seller page actually shows, in data-index order. */
const EXPECTED_URLS = [
  `${CDN}/S8fd9295e27d5466ca11dedc3a64857b2n.jpg`,
  `${CDN}/S4ecf10a187e34daabddbfca15997e2929.jpg`,
  `${CDN}/Sd257025ca09147e391b716941dc54c37j.jpg`,
  `${CDN}/S042f77574d3e44efbc856a35174cdd7fn.jpg`,
  `${CDN}/S6c7fb06b3d21475d9acc4319e9cdeef7Y.jpg`,
];

function mountFixture(html = FIXTURE): void {
  document.body.innerHTML = html;
}

describe('scanDocument — seller image widget', () => {
  beforeEach(() => mountFixture());

  it('extracts exactly the product slots of .imageUploadWrap, in order', () => {
    const { images, strategy } = scanDocument(document);

    expect(strategy).toBe('seller-widget');
    expect(images.map((image) => image.normalizedUrl)).toEqual(EXPECTED_URLS);
    expect(images.map((image) => image.index)).toEqual([0, 1, 2, 3, 4]);
    // `slotIndex` is the page's own `data-index` — the stable identity the page
    // keeps across re-renders, and what the page-fill flow appends after.
    expect(images.map((image) => image.slotIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(images.every((image) => image.sourceType === 'main')).toBe(true);
  });

  it('never double-counts the hover-tooltip duplicate of a slot image', () => {
    const urls = scanDocument(document).images.map((image) => image.url);

    const countMatching = (needle: string): number => urls.filter((url) => url.includes(needle)).length;

    expect(urls).toHaveLength(new Set(urls).size);
    // Items 0 and 1 each render the same <img> twice (card + tooltip).
    expect(countMatching('S8fd9295e27d5466ca11dedc3a64857b2n')).toBe(1);
    expect(countMatching('S4ecf10a187e34daabddbfca15997e2929')).toBe(1);
  });

  it('skips the trailing empty slot (placeholder, no has-url / no img)', () => {
    const images = scanDocument(document).images;
    const urls = images.map((image) => image.url).join(' ');

    expect(images).toHaveLength(5);
    expect(urls).not.toContain('upload');
  });

  it('ignores .sell-o-image-item.has-url that lives outside the widget', () => {
    const urls = scanDocument(document).images.map((image) => image.url).join(' ');

    expect(urls).not.toContain('Ssku999notwanted');
  });

  it('still finds every slot when the wrapper is truncated and the sections split apart', () => {
    mountFixture(`
      <div class="imageUploadWrap">
        <div class="sell-o-image-item has-url" data-index="0">
          <div class="image-card"><img src="${CDN}/Smain0.jpg" /></div>
        </div>
      </div>
      <div class="moreImagesSection">
        <div class="moreImagesList">
          <div class="sell-o-image-item has-url" data-index="1">
            <div class="image-card"><img src="${CDN}/Smore1.jpg" /></div>
          </div>
          <div class="sell-o-image-item has-url" data-index="2">
            <div class="image-card"><img src="${CDN}/Smore2.jpg" /></div>
          </div>
        </div>
      </div>
    `);
    expect(scanDocument(document).images.map((image) => image.normalizedUrl)).toEqual([
      `${CDN}/Smain0.jpg`,
      `${CDN}/Smore1.jpg`,
      `${CDN}/Smore2.jpg`,
    ]);
  });

  it('reads the slot label from .header-text and drops the meaningless alt="url"', () => {
    const images = scanDocument(document).images;

    expect(images.map((image) => image.label)).toEqual([
      '商品正面图',
      '商品背面图',
      '商品实拍图',
      '商品侧面图',
      '商品细节图',
    ]);
    expect(images.every((image) => image.alt === undefined)).toBe(true);
  });

  it('honours lazy-load attributes when src is empty', () => {
    const lazy = scanDocument(document).images.find((image) => image.normalizedUrl.endsWith('S042f77574d3e44efbc856a35174cdd7fn.jpg'));

    expect(lazy).toBeDefined();
    expect(lazy?.width).toBe(800);
    expect(lazy?.height).toBe(800);
  });

  it('never picks up page chrome or data: URLs', () => {
    const urls = scanDocument(document).images.map((image) => image.url).join(' ');

    expect(urls).not.toContain('data:');
    expect(urls).not.toContain('.svg');
    expect(urls).not.toContain('icon-cart');
    expect(urls).not.toContain('logo');
  });

  it('returns a stable id per normalised url', () => {
    const first = scanDocument(document).images;
    const second = scanDocument(document).images;
    expect(first.map((image) => image.id)).toEqual(second.map((image) => image.id));
  });

  it('prefers data-index over DOM order when every slot carries one', () => {
    mountFixture(`
      <div class="imageUploadWrap">
        <div class="moreImagesList">
          <div class="sell-o-image-item has-url" data-index="1">
            <div class="image-card"><img src="${CDN}/Ssecond.jpg" /></div>
          </div>
          <div class="sell-o-image-item has-url" data-index="0">
            <div class="image-card"><img src="${CDN}/Sfirst.jpg" /></div>
          </div>
        </div>
      </div>
    `);
    expect(scanDocument(document).images.map((image) => image.normalizedUrl)).toEqual([
      `${CDN}/Sfirst.jpg`,
      `${CDN}/Ssecond.jpg`,
    ]);
    // The reported slots must follow the same order: Sfirst really is slot 0.
    expect(scanDocument(document).images.map((image) => image.slotIndex)).toEqual([0, 1]);
  });

  it('falls back to DOM order when data-index is missing', () => {
    mountFixture(`
      <div class="imageUploadWrap">
        <div class="moreImagesList">
          <div class="sell-o-image-item has-url"><div class="image-card"><img src="${CDN}/Sa.jpg" /></div></div>
          <div class="sell-o-image-item has-url"><div class="image-card"><img src="${CDN}/Sb.jpg" /></div></div>
        </div>
      </div>
    `);
    expect(scanDocument(document).images.map((image) => image.normalizedUrl)).toEqual([
      `${CDN}/Sa.jpg`,
      `${CDN}/Sb.jpg`,
    ]);
    // No usable slot number on the page — an absent field, never a guessed 0/1.
    expect(scanDocument(document).images.map((image) => image.slotIndex)).toEqual([undefined, undefined]);
  });

  it('dedupes differently decorated URLs of the same asset', () => {
    mountFixture(`
      <div class="imageUploadWrap">
        <div class="moreImagesList">
          <div class="sell-o-image-item has-url" data-index="0">
            <div class="image-card"><img src="${CDN}/Saaa111.jpg_220x220.jpg" /></div>
          </div>
          <div class="sell-o-image-item has-url" data-index="1">
            <div class="image-card"><img src="${CDN}/Saaa111.jpg_Q90.jpg_.webp" /></div>
          </div>
        </div>
      </div>
    `);
    expect(scanDocument(document).images).toHaveLength(1);
  });

  it('never aborts on a single broken slot', () => {
    mountFixture(`
      <div class="imageUploadWrap">
        <div class="moreImagesList">
          <div class="sell-o-image-item has-url" data-index="0"><div class="image-card"><img src="${CDN}/Sok1.jpg" /></div></div>
          <div class="sell-o-image-item has-url" data-index="1"><div class="image-card"><img /></div></div>
          <div class="sell-o-image-item has-url" data-index="2"><div class="image-card"><img src="${CDN}/Sok2.jpg" /></div></div>
        </div>
      </div>
    `);
    expect(scanDocument(document).images).toHaveLength(2);
  });

  it('accepts a slot image from an unknown host (no size / CDN guessing)', () => {
    const candidate = { url: 'https://cdn.example.test/kf/unknown-host.jpg', width: 0, height: 0, alt: '', order: 0 };

    expect(isUsableWidgetCandidate(candidate)).toBe(true);
    expect(isUsableCandidate(candidate)).toBe(false);
  });

  it('collectFromSellerWidget returns raw candidates without dedupe', () => {
    expect(collectFromSellerWidget(document)).toHaveLength(5);
  });
});

describe('scanDocument — generic fallbacks', () => {
  it('uses a generic container when the seller widget is absent', () => {
    mountFixture(`
      <div class="image-uploader">
        <img src="https://ae01.alicdn.com/kf/Sok1.jpg" />
        <img />
        <img src="https://ae01.alicdn.com/kf/Sok2.jpg" />
      </div>
    `);
    const { images, strategy } = scanDocument(document);

    expect(strategy).toContain('container');
    expect(images).toHaveLength(2);
  });

  it('falls back to a page-wide product-CDN pass when no container matches', () => {
    mountFixture(`
      <div class="page-footer">
        <img src="https://ae04.alicdn.com/kf/Sddd444.jpg" alt="详情图" />
        <img src="https://example.com/logo.svg" alt="logo" />
      </div>
    `);
    const { images, strategy } = scanDocument(document);

    expect(strategy).toBe('document:product-cdn');
    expect(images.map((image) => image.normalizedUrl)).toEqual(['https://ae04.alicdn.com/kf/Sddd444.jpg']);
  });

  it('drops known-size images that are too small to be a product photo', () => {
    mountFixture(`
      <div class="image-uploader">
        <img src="https://ae01.alicdn.com/kf/Stiny.jpg" width="24" height="24" />
        <img src="https://ae01.alicdn.com/kf/Sbig.jpg" width="1000" height="1000" />
      </div>
    `);
    expect(scanDocument(document).images.map((image) => image.normalizedUrl)).toEqual([
      'https://ae01.alicdn.com/kf/Sbig.jpg',
    ]);
  });

  it('returns an empty result instead of throwing when nothing matches', () => {
    mountFixture('<div><img src="/relative/x.png" /><img src="data:image/gif;base64,AA" /></div>');
    expect(scanDocument(document).images).toEqual([]);
  });
});

describe('AliExpressPageAdapter', () => {
  beforeEach(() => mountFixture());

  it('accepts a seller product path', () => {
    window.history.replaceState({}, '', '/product/publish.htm');
    const adapter = new AliExpressPageAdapter(document);
    expect(adapter.isSupportedPage()).toBe(true);
  });

  it('falls back to DOM markers for hash-based routes', () => {
    window.history.replaceState({}, '', '/#/publish');
    const adapter = new AliExpressPageAdapter(document);
    expect(adapter.isSupportedPage()).toBe(true);
  });

  it('rejects unrelated routes without main-image markers', () => {
    window.history.replaceState({}, '', '/help/faq');
    document.body.innerHTML = '<div>help</div>';
    const adapter = new AliExpressPageAdapter(document);
    expect(adapter.isSupportedPage()).toBe(false);
  });
});

describe('isUsableCandidate / readImageSize', () => {
  it('requires a product CDN when the size is unknown', () => {
    expect(isUsableCandidate({ url: 'https://unknown.test/a.jpg', width: 0, height: 0, alt: '', order: 0 })).toBe(false);
    expect(
      isUsableCandidate({ url: 'https://ae01.alicdn.com/kf/a.jpg', width: 0, height: 0, alt: '', order: 0 }),
    ).toBe(true);
  });

  it('reads attribute size when naturalWidth is unavailable', () => {
    const img = document.createElement('img');
    img.setAttribute('width', '640');
    img.setAttribute('height', '480');
    expect(readImageSize(img)).toEqual([640, 480]);
  });
});
