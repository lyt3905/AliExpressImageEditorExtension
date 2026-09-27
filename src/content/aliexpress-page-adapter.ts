/**
 * AliExpress seller-console adapter.
 *
 * v1 supports the seller product edit/publish pages only. Everything else is
 * rejected early so the service worker can surface a clear message.
 */

import type { PageImageAdapter, ScannedImage } from '../shared/types';
import { scanDocument, type ScanOptions } from './image-scanner';

const SELLER_HOST = /(^|\.)aliexpress\.com$/i;
const PRODUCT_PATH = /(publish|product|item|edit|offer)/i;

const PAGE_MARKERS: readonly string[] = [
  '.sell-o-image-item',
  '[class*="main-image"]',
  '[class*="image-upload"]',
];

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
      if (!SELLER_HOST.test(hostname)) return false;
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
}
