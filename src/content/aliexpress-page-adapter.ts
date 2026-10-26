/**
 * AliExpress seller-console adapter.
 *
 * v1 supports the seller product edit/publish pages only. Everything else is
 * rejected early so the service worker can surface a clear message.
 */

import type { PageImageAdapter, ScannedImage } from '../shared/types';
import { SELLER_HOST_PATTERN } from '../shared/page-gate';
import { scanDocument, type ScanOptions } from './image-scanner';

const PRODUCT_PATH = /(publish|product|item|edit|offer)/i;

const PAGE_MARKERS: readonly string[] = [
  '.sell-o-image-item',
  '[class*="main-image"]',
  '[class*="image-upload"]',
];

/**
 * Title-input selector: the publish/edit form's 标题 box.
 * `<input placeholder="请输入标题" field="title" name="title" ...>`
 */
const TITLE_INPUT_SELECTOR = 'input[name="title"][type="text"], input[field="title"], input[placeholder="请输入标题"]';
/**
 * A code like `xxx-xxx` (e.g. `MTS-TF-SS86-0001`) embedded in the title.
 *
 * At least one hyphen is required — a plain word is not a code. Only letters and
 * digits may form the segments.
 *
 * A second rule was added after seeing it fail on real titles: **the match must
 * contain at least one digit**. Without it, ordinary hyphenated English in a listing
 * (`micro-scale`, `pre-order`, `high-quality`) was taken for the product code and
 * printed onto the 主图. A code without any digit is far rarer than those words.
 */
const TITLE_CODE = /([A-Za-z0-9]+(?:-[A-Za-z0-9]+)+)/;

export class AliExpressPageAdapter implements PageImageAdapter {
  private readonly doc: Document;
  private readonly scanOptions: ScanOptions;

  constructor(doc: Document, scanOptions: ScanOptions = {}) {
    this.doc = doc;
    this.scanOptions = scanOptions;
  }

  isSupportedPage(): boolean {
    try {
      const { hostname, pathname } = this.doc.location ?? window.location;
      if (!SELLER_HOST_PATTERN.test(hostname)) return false;
      if (PRODUCT_PATH.test(pathname)) return true;
      // Some seller routes are hash-based; fall back to DOM markers.
      return PAGE_MARKERS.some((selector) => this.doc.querySelector(selector) !== null);
    } catch {
      return false;
    }
  }

  /** Total number of <img> elements on the page — useful for diagnostics. */
  countImages(): number {
    try {
      return this.doc.querySelectorAll('img').length;
    } catch {
      return 0;
    }
  }

  scanMainImages(): ScannedImage[] {
    return scanDocument(this.doc, this.scanOptions).images;
  }

  scanMainImagesWithStrategy(): { images: ScannedImage[]; strategy: string } {
    return scanDocument(this.doc, this.scanOptions);
  }

  /**
   * The product title as the seller typed it (the 标题 input's value).
   * Used for brand keyword matching; `null` when the box is absent/empty.
   */
  extractProductTitle(): string | null {
    try {
      const input = this.doc.querySelector<HTMLInputElement>(TITLE_INPUT_SELECTOR);
      const title = input?.value?.trim();
      return title || null;
    } catch {
      return null;
    }
  }

  /**
   * Extract the product code that gets printed onto the main image.
   *
   * **Only a `xxx-xxx` shaped code inside the 标题 input counts.** There is no
   * numeric fallback on purpose: the URL's `productId` is the Alibaba offer id (a
   * 16-digit number), and stamping that onto a 主图 reads as a mistake to buyers.
   * When the title carries no such code the result is `null`, and the canvas simply
   * gets no code layer — an empty slot is better than a wrong number.
   */
  extractProductCode(): string | null {
    try {
      const input = this.doc.querySelector<HTMLInputElement>(TITLE_INPUT_SELECTOR);
      const title = input?.value?.trim();
      if (!title) return null;

      // Every match is considered, not just the first: a title like
      // "Pre-order MTS-TF-0001" starts with a hyphenated WORD, and stopping at the
      // first match would drop the real code behind it.
      const pattern = new RegExp(TITLE_CODE.source, 'g');
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(title)) !== null) {
        const candidate = match[1];
        // `micro-scale` / `pre-order` / `high-quality` are words, not codes.
        if (candidate && /[0-9]/.test(candidate)) return candidate;
      }
      return null;
    } catch {
      return null;
    }
  }
}
