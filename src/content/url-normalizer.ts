/**
 * URL normalisation for AliExpress image CDNs.
 *
 * AliExpress serves the same asset under many decorated URLs, e.g.
 *   https://ae01.alicdn.com/kf/Sabc.jpg_220x220.jpg
 *   https://ae01.alicdn.com/kf/Sabc.jpg_Q90.jpg
 *   https://ae01.alicdn.com/kf/Sabc.jpg_.webp
 * All three are the same picture; we cut the filename at the first image
 * extension so that dedupe actually works.
 */

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|bmp|avif|gif)(?![a-z0-9])/i;

/** Non-alphanumeric boundaries so `icon-cart.png`, `logo.png` and `alt="icon"` all match. */
const DECORATIVE_HINT =
  /(?:^|[^a-z0-9])(icon|ico|logo|sprite|flag|avatar|badge|arrow|close|delete|plus|add|edit|loading|spinner|placeholder|qrcode|qr-code|watermark|blank|transparent|empty|default)(?:[^a-z0-9]|$)/i;

export function isHttpUrl(value: unknown): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

/** `data:`, `blob:`, and non-image file types can never be product photos. */
export function isDecorativeUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return true;
  const url = value.trim();
  if (/^(data|blob|chrome|chrome-extension|about):/i.test(url)) return true;
  if (!/^https?:\/\//i.test(url)) return true;
  if (/\.svg(\?|#|$)/i.test(url)) return true;
  if (/\.gif(\?|#|$)/i.test(url)) return true;
  return false;
}

/** Strip the decoration suffixes AliExpress CDNs append to image paths. */
export function stripImageDecoration(pathname: string): string {
  const match = IMAGE_EXTENSION.exec(pathname);
  if (!match) return pathname;
  return pathname.slice(0, match.index + match[0].length);
}

/**
 * Normalise an image URL into a stable dedupe key.
 * Returns '' when the input cannot be normalised.
 */
export function normalizeImageUrl(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (!value) return '';
  if (value.startsWith('//')) value = `https:${value}`;
  if (!/^https?:\/\//i.test(value)) return '';

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return '';
  }

  const host = parsed.host.toLowerCase();
  const pathname = stripImageDecoration(parsed.pathname);
  return `${parsed.protocol.toLowerCase()}//${host}${pathname}`;
}

/** True when a URL or its alt/label text looks like page chrome rather than a product photo. */
export function hasDecorativeHint(value: unknown): boolean {
  return typeof value === 'string' && DECORATIVE_HINT.test(value);
}

/** Stable, collision-resistant id for a normalised URL. */
export function hashImageUrl(normalizedUrl: string): string {
  let hash = 5381;
  for (let index = 0; index < normalizedUrl.length; index += 1) {
    hash = ((hash << 5) + hash + normalizedUrl.charCodeAt(index)) | 0;
  }
  const unsigned = (hash >>> 0).toString(36);
  const tail = normalizedUrl.slice(-24).replace(/[^a-z0-9]/gi, '').slice(-12);
  return `img-${unsigned}-${tail || 'x'}`;
}
