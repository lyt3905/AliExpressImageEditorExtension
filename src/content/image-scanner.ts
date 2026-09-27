/**
 * Product-image scanner.
 *
 * Strategy order (first non-empty wins):
 *   1. `seller-widget`     — the exact widget the seller console uses for the
 *                            product image slots. This is the ONLY thing we want
 *                            on an edit page, so it is tried first.
 *   2. `container:<sel>`   — generic main-image containers (older layouts).
 *   3. `document:product-cdn` — page-wide pass restricted to product CDNs.
 *
 * The seller console markup we target:
 *
 *   .imageUploadWrap
 *     ├─ .mainImageSection   主图
 *     │   └─ .image-uploader > .sell-o-image-item.has-url[data-index="0"]
 *     │        ├─ .image-item-header-bar > .header-text   ("商品正面图")
 *     │        └─ .sell-o-image-item-preview > .image-card > img
 *     └─ .moreImagesSection  更多图片
 *         └─ .moreImagesList > .image-uploader > .sell-o-image-item[has-url][data-index="1..4"]
 *
 * Two traps in this markup, both handled below:
 *   - An occupied slot also renders a hover tooltip (`.ae-image-hover` inside
 *     `.ait-tooltip`) holding a SECOND <img> with the same URL. Scanning the
 *     slot blindly would double-count every image.
 *   - The next empty slot is a `.sell-o-image-item` WITHOUT `has-url` and
 *     without an <img> (it only holds an SVG "上传图片" placeholder).
 */

import type { ScannedImage } from '../shared/types';
import { hashImageUrl, hasDecorativeHint, isDecorativeUrl, isHttpUrl, normalizeImageUrl } from './url-normalizer';

// ---------------------------------------------------------------- seller widget

/** Roots of the seller product-image widget, most specific first. */
export const SELLER_WIDGET_ROOTS: readonly string[] = [
  '.imageUploadWrap',
  '.mainImageSection',
  '.moreImagesSection',
];

/** One image slot. Occupied slots additionally carry `has-url`. */
export const SELLER_ITEM_SELECTOR = '.sell-o-image-item';

/** The real asset lives in `.image-card`; the tooltip holds the same one again. */
const ITEM_IMAGE_SELECTORS: readonly string[] = ['.image-card img', '.sell-o-image-item-preview img'];

/** Hover-preview tooltips repeat the slot <img> — never scan them. */
const TOOLTIP_ANCESTOR = '.ae-image-hover, .ait-tooltip';

/** Human label for a slot, e.g. 商品正面图 / 商品背面图 / 商品实拍图. */
const ITEM_LABEL_SELECTOR = '.header-text';

/** `alt="url"` (and friends) carries no information — treat it as absent. */
const JUNK_ALT = /^(url|image|img|picture|photo|thumbnail|thumb|a|undefined|null)$/i;

// ---------------------------------------------------------------- generic fallback

/** Containers that hold product images in other / older console layouts. */
export const MAIN_IMAGE_ROOT_SELECTORS: readonly string[] = [
  '.sell-o-image-item',
  '[class*="main-image"]',
  '[class*="mainImage"]',
  '[class*="main_images"]',
  '.image-uploader',
  '[class*="image-upload"]',
  '[class*="image-list"]',
  '[class*="imageList"]',
  '[data-testid*="main-image"]',
];

/** Anything from these hosts with a plausible size is treated as a product photo. */
const PRODUCT_CDN = /(alicdn\.com|aliexpress-media\.com|ae0[0-9]\.alicdn)/i;

/** Images smaller than this (either side) are page chrome. */
export const MIN_SIDE = 80;

/** `object-fit`/lazy-load attributes worth reading when `src` is still unset. */
const LAZY_ATTRIBUTES = ['data-src', 'data-lazy-src', 'data-original', 'data-ks-lazyload', 'data-image', 'data-url'];

export interface ScanOptions {
  minSide?: number;
  /** Restrict the fallback pass to known product CDNs (default true). */
  requireProductCdnForFallback?: boolean;
}

interface RawCandidate {
  url: string;
  width: number;
  height: number;
  alt: string;
  order: number;
  /** Slot label from the page (e.g. 商品正面图), when the markup provides one. */
  label?: string;
}

function safeQueryAll(root: ParentNode, selector: string): Element[] {
  try {
    return Array.from(root.querySelectorAll(selector));
  } catch {
    return [];
  }
}

function readElement(element: Element | null, key: string): string {
  if (!element) return '';
  try {
    const value = element.getAttribute(key);
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

function readNumericAttribute(element: Element, key: string): number | null {
  const raw = readElement(element, key).trim();
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function textOf(element: Element | null): string {
  if (!element) return '';
  try {
    return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- url / size

/**
 * Resolve the URL of one <img>.
 *
 * Candidates are tried in priority order (srcset / lazy-load attributes are
 * consulted when `src` is unset), and only http(s) candidates are accepted —
 * a browser may resolve an empty `src` to the document URL, which must never be
 * mistaken for a product photo.
 */
function readImageUrl(image: Element): string {
  const element = image as HTMLImageElement;
  const candidates: string[] = [];
  const documentUrl = documentUrlOf(image);

  try {
    if (typeof element.currentSrc === 'string' && element.currentSrc) candidates.push(element.currentSrc);
  } catch {
    /* detached or cross-origin node */
  }
  try {
    if (typeof element.src === 'string' && element.src) candidates.push(element.src);
  } catch {
    /* ignore */
  }

  const srcAttribute = readElement(image, 'src');
  if (srcAttribute) candidates.push(srcAttribute);

  const srcset = readElement(image, 'srcset');
  if (srcset) {
    const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
    if (first) candidates.push(first);
  }
  for (const attribute of LAZY_ATTRIBUTES) {
    const value = readElement(image, attribute);
    if (value) candidates.push(value);
  }

  for (const candidate of candidates) {
    const value = candidate.trim();
    if (!value || !isHttpUrl(value) || isDecorativeUrl(value)) continue;
    // A browser resolves `src=""` to the document URL — never a product photo.
    if (documentUrl && value === documentUrl) continue;
    return value;
  }
  return '';
}

function documentUrlOf(element: Element): string {
  try {
    const href = element.ownerDocument?.location?.href;
    return typeof href === 'string' ? href.split('#')[0] ?? '' : '';
  } catch {
    return '';
  }
}

/** Best-effort pixel size. Returns [0, 0] when the image has not loaded yet. */
export function readImageSize(image: Element): [number, number] {
  const element = image as HTMLImageElement;
  const naturalWidth = Number(element.naturalWidth) || 0;
  const naturalHeight = Number(element.naturalHeight) || 0;
  if (naturalWidth > 0 && naturalHeight > 0) return [naturalWidth, naturalHeight];

  const attributeWidth = Number(readElement(image, 'width')) || 0;
  const attributeHeight = Number(readElement(image, 'height')) || 0;
  if (attributeWidth > 0 && attributeHeight > 0) return [attributeWidth, attributeHeight];

  const domWidth = Number(element.width) || 0;
  const domHeight = Number(element.height) || 0;
  if (domWidth > 0 && domHeight > 0) return [domWidth, domHeight];

  try {
    const rect = typeof element.getBoundingClientRect === 'function' ? element.getBoundingClientRect() : null;
    if (rect && rect.width > 0 && rect.height > 0) return [Math.round(rect.width), Math.round(rect.height)];
  } catch {
    /* ignore */
  }
  return [0, 0];
}

function cleanAlt(value: string): string {
  const alt = value.trim();
  if (!alt || JUNK_ALT.test(alt)) return '';
  return alt;
}

function toRawCandidate(image: Element, order: number, label?: string): RawCandidate {
  const url = readImageUrl(image);
  const [width, height] = readImageSize(image);
  const candidate: RawCandidate = { url, width, height, alt: cleanAlt(readElement(image, 'alt')), order };
  const trimmedLabel = label?.trim();
  if (trimmedLabel) candidate.label = trimmedLabel;
  return candidate;
}

// ---------------------------------------------------------------- seller widget extraction

function insideTooltip(element: Element): boolean {
  try {
    return typeof element.closest === 'function' && element.closest(TOOLTIP_ANCESTOR) !== null;
  } catch {
    return false;
  }
}

/** The real slot image — `.image-card` first, tooltips and icons excluded. */
function usableImageIn(slot: Element): Element | null {
  for (const selector of ITEM_IMAGE_SELECTORS) {
    for (const image of safeQueryAll(slot, selector)) {
      if (insideTooltip(image)) continue;
      if (readImageUrl(image)) return image;
    }
  }
  for (const image of safeQueryAll(slot, 'img')) {
    if (insideTooltip(image)) continue;
    if (readImageUrl(image)) return image;
  }
  return null;
}

/**
 * Occupied slots carry `has-url`; the empty "上传图片" placeholder carries
 * neither that class nor an <img>. Both signals are accepted so a class rename
 * alone does not silently drop the whole scan.
 */
function isFilledSlot(slot: Element): boolean {
  try {
    if (typeof slot.classList?.contains === 'function' && slot.classList.contains('has-url')) return true;
  } catch {
    /* ignore */
  }
  return usableImageIn(slot) !== null;
}

function contains(parent: Element, child: Element): boolean {
  try {
    return typeof parent.contains === 'function' && parent.contains(child);
  } catch {
    return false;
  }
}

/**
 * Every matched widget root, minus the ones nested inside another match
 * (`.imageUploadWrap` contains both sections, so the sections drop out).
 *
 * Taking the union instead of stopping at the first non-empty root means a
 * partially-truncated outer wrapper can never hide the remaining slots.
 */
function sellerWidgetRoots(doc: Document): Element[] {
  const matched: Element[] = [];
  for (const selector of SELLER_WIDGET_ROOTS) matched.push(...safeQueryAll(doc, selector));
  return matched.filter((root) => !matched.some((other) => other !== root && contains(other, root)));
}

/**
 * Every occupied slot inside the widget, in the seller's own order.
 *
 * `data-index` is the authority when every slot has a distinct one (it survives
 * DOM re-ordering); otherwise DOM order is used.
 */
function sellerWidgetSlots(doc: Document): Element[] {
  const slots: Element[] = [];
  const seen = new Set<Element>();

  for (const root of sellerWidgetRoots(doc)) {
    for (const slot of safeQueryAll(root, SELLER_ITEM_SELECTOR)) {
      if (seen.has(slot)) continue;
      seen.add(slot);
      slots.push(slot);
    }
  }

  const filled = slots.filter(isFilledSlot);
  if (!filled.length) return [];

  const indexed = filled.map((slot) => readNumericAttribute(slot, 'data-index'));
  const allIndexed = indexed.every((value): value is number => value !== null);
  if (!allIndexed || new Set(indexed).size !== filled.length) return filled;

  return filled
    .map((slot, position) => ({ slot, position, index: indexed[position] ?? position }))
    .sort((left, right) => left.index - right.index || left.position - right.position)
    .map((entry) => entry.slot);
}

/**
 * Slot images are product photos by construction, so no size / CDN guessing is
 * applied here — only the junk filters.
 */
export function isUsableWidgetCandidate(candidate: RawCandidate): boolean {
  if (!isHttpUrl(candidate.url)) return false;
  if (isDecorativeUrl(candidate.url)) return false;
  if (hasDecorativeHint(candidate.url)) return false;
  if (candidate.label && hasDecorativeHint(candidate.label)) return false;
  return true;
}

export function collectFromSellerWidget(doc: Document): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  let order = 0;

  for (const slot of sellerWidgetSlots(doc)) {
    try {
      const image = usableImageIn(slot);
      if (!image) continue;
      const candidate = toRawCandidate(image, order, textOf(slot.querySelector(ITEM_LABEL_SELECTOR)));
      order += 1;
      if (isUsableWidgetCandidate(candidate)) candidates.push(candidate);
    } catch {
      // A single broken node must never abort the whole scan.
      order += 1;
    }
  }
  return candidates;
}

// ---------------------------------------------------------------- generic fallback

/** Reject data:, blob:, svg, gif, icons/logos/avatars/placeholders and tiny images. */
export function isUsableCandidate(candidate: RawCandidate, minSide = MIN_SIDE): boolean {
  if (!isHttpUrl(candidate.url)) return false;
  if (isDecorativeUrl(candidate.url)) return false;
  if (hasDecorativeHint(candidate.url)) return false;
  if (hasDecorativeHint(candidate.alt)) return false;

  const known = candidate.width > 0 && candidate.height > 0;
  if (known && Math.min(candidate.width, candidate.height) < minSide) return false;
  if (!known && !PRODUCT_CDN.test(candidate.url)) return false;
  return true;
}

/**
 * Dedupe by normalised URL (keeping the first occurrence) and renumber.
 * Order on the page is preserved.
 */
export function normalizeCandidates(candidates: readonly RawCandidate[]): ScannedImage[] {
  const seenNormalized = new Set<string>();
  const seenRaw = new Set<string>();
  const ordered = [...candidates].sort((left, right) => left.order - right.order);
  const out: ScannedImage[] = [];

  for (const candidate of ordered) {
    if (seenRaw.has(candidate.url)) continue;
    const normalizedUrl = normalizeImageUrl(candidate.url);
    if (!normalizedUrl) continue;
    if (seenNormalized.has(normalizedUrl)) continue;
    seenRaw.add(candidate.url);
    seenNormalized.add(normalizedUrl);
    out.push({
      id: hashImageUrl(normalizedUrl),
      index: out.length,
      url: candidate.url,
      normalizedUrl,
      width: candidate.width,
      height: candidate.height,
      ...(candidate.alt ? { alt: candidate.alt } : {}),
      ...(candidate.label ? { label: candidate.label } : {}),
      sourceType: 'main',
    });
  }
  return out;
}

function collectFromRoots(doc: Document, selector: string, startOrder: number, minSide: number): RawCandidate[] {
  const roots = safeQueryAll(doc, selector);
  const candidates: RawCandidate[] = [];
  let order = startOrder;

  for (const root of roots) {
    for (const image of safeQueryAll(root, 'img')) {
      try {
        const candidate = toRawCandidate(image, order);
        order += 1;
        if (candidate && isUsableCandidate(candidate, minSide)) candidates.push(candidate);
      } catch {
        // A single broken node must never abort the whole scan.
        order += 1;
      }
    }
  }
  return candidates;
}

function collectFromWholeDocument(doc: Document, startOrder: number, minSide: number): RawCandidate[] {
  const candidates: RawCandidate[] = [];
  let order = startOrder;
  for (const image of safeQueryAll(doc, 'img')) {
    try {
      const candidate = toRawCandidate(image, order);
      order += 1;
      if (!candidate) continue;
      if (!isUsableCandidate(candidate, minSide)) continue;
      if (!PRODUCT_CDN.test(candidate.url)) continue;
      candidates.push(candidate);
    } catch {
      order += 1;
    }
  }
  return candidates;
}

export interface ScanOutcome {
  images: ScannedImage[];
  strategy: string;
}

/**
 * Scan a document for the product images worth editing.
 *
 * Strategy 1: the seller console's own image widget (exact match).
 * Strategy 2: known main-image containers (older layouts).
 * Strategy 3: page-wide product-CDN pass.
 */
export function scanDocument(doc: Document, options: ScanOptions = {}): ScanOutcome {
  const minSide = options.minSide ?? MIN_SIDE;
  const requireProductCdn = options.requireProductCdnForFallback ?? true;

  try {
    const widgetImages = normalizeCandidates(collectFromSellerWidget(doc));
    if (widgetImages.length) return { images: widgetImages, strategy: 'seller-widget' };

    for (const selector of MAIN_IMAGE_ROOT_SELECTORS) {
      const raw = collectFromRoots(doc, selector, 0, minSide);
      const images = normalizeCandidates(raw);
      if (images.length) return { images, strategy: `container:${selector}` };
    }

    const raw = requireProductCdn
      ? collectFromWholeDocument(doc, 0, minSide)
      : collectFromRoots(doc, 'body', 0, minSide);
    return { images: normalizeCandidates(raw), strategy: 'document:product-cdn' };
  } catch {
    return { images: [], strategy: 'failed' };
  }
}
