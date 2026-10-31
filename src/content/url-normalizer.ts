/**
 * URL normalisation for AliExpress image CDNs.
 *
 * AliExpress serves the same asset under many decorated URLs, e.g.
 *   https://ae01.alicdn.com/kf/Sabc.jpg_220x220.jpg
 *   https://ae01.alicdn.com/kf/Sabc.jpg_Q90.jpg
 *   https://ae01.alicdn.com/kf/Sabc.jpg_.webp
 * All three are the same picture; we cut the filename at the first image
 * extension so that dedupe actually works.
 *
 * 这两个函数搬到了 `src/shared/image-url.ts`（编辑器算缓存身份也要用同一套规则 ——
 * 见那个文件里的说明），这里只是转出去，内容脚本与测试仍然从这里拿。
 */

export { normalizeImageUrl, stripImageDecoration } from '../shared/image-url';

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
