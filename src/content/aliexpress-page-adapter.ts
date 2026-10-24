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

/** "商品编号：1000001234567890" / "Product ID: 1000001234567890" and friends. */
const PRODUCT_CODE_TEXT = /(?:商品编号|商品ID|Product\s*ID)\s*[:：]?\s*(\d{6,20})/i;
/** URL query keys that carry the product id on the seller console. */
const PRODUCT_URL_KEYS: readonly string[] = ['productId', 'product_id', 'offerId', 'offer_id'];
/**
 * Title-input selector: the publish/edit form's 标题 box.
 * `<input placeholder="请输入标题" field="title" name="title" ...>`
 */
const TITLE_INPUT_SELECTOR = 'input[name="title"][type="text"], input[field="title"], input[placeholder="请输入标题"]';
/**
 * A code like `xxx-xxx` (e.g. `MTS-TF-SS86-0001`) embedded in the title.
 *
 * At least one hyphen is required — a plain word is not a code. Only letters
 * and digits may form the segments, so hyphenated English words in the title
 * (e.g. `micro-scale`) can still sneak in; that is accepted because the seller
 * sees the extracted text on the canvas and can delete it.
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
   * Extract the product code from the product edit page.
   *
   * Order of preference:
   *   1. a `xxx-xxx` style code inside the 标题 input's value (e.g.
   *      `MTS-TF-SS86-0001` inside the title text) — the seller's own code;
   *   2. the URL's `productId` / `offerId` query parameter;
   *   3. page text of the form 「商品编号：123…」 / "Product ID: 123…".
   *
   * Returns `null` when nothing looks like a product code.
   */
  extractProductCode(): string | null {
    // The title input box: its value is the product title as the seller typed
    // it, which is where the SKU-style code lives. Checked FIRST — the URL's
    // numeric productId is always present, so any other order would never
    // reach the title code at all.
    try {
      const input = this.doc.querySelector<HTMLInputElement>(TITLE_INPUT_SELECTOR);
      const title = input?.value?.trim();
      if (title) {
        const match = TITLE_CODE.exec(title);
        if (match?.[1]) return match[1];
      }
    } catch {
      /* fall through */
    }

    try {
      const { search } = this.doc.location ?? window.location;
      const params = new URLSearchParams(search);
      for (const key of PRODUCT_URL_KEYS) {
        const value = params.get(key);
        if (value && /^\d{6,20}$/.test(value)) return value;
      }
    } catch {
      /* fall through to DOM extraction */
    }

    try {
      const body = this.doc.body;
      if (body) {
        // Visible text only: hidden nodes often carry unrelated numeric ids.
        const walker = this.doc.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            const parent = (node as CharacterData).parentElement;
            if (!parent) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(parent);
            return style && style.visibility !== 'hidden' && style.display !== 'none'
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT;
          },
        });
        let node: Node | null;
        while ((node = walker.nextNode()) !== null) {
          const match = PRODUCT_CODE_TEXT.exec((node as CharacterData).data || '');
          if (match?.[1]) return match[1];
        }
      }
    } catch {
      /* best-effort; a missing code is never fatal */
    }
    return null;
  }
}
