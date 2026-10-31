/**
 * 图片 URL 的规范化（站点无关的纯函数）。
 *
 * 两个地方要用同一套规则：
 * - 内容脚本扫描图片时，用它算出"同一张图"的去重 id（`src/content/url-normalizer.ts`）；
 * - 编辑器算本地缓存的身份时，用它当 key（`src/services/compose-cache.ts`）。
 *
 * 分开写过一次，结果是同一张照片在扫描侧去重成功、在缓存侧却每次都不命中 ——
 * 因为缓存侧直接拿了 `currentSrc` 原文，而它带着 `_960x960.jpg` / `_.webp` 这类装饰。
 */

const IMAGE_EXTENSION = /\.(jpe?g|png|webp|bmp|avif|gif)(?![a-z0-9])/i;

/**
 * AliExpress 的图片 CDN 家族。
 *
 * 同一个资产会在这些主机之间轮换（`ae01.alicdn.com` / `ae-pic-a1.aliexpress-media.com` /
 * `ae04.alicdn.com` …），有时只是页面版本不同。它们指的都是 `kf/<hash>` 那一个文件，
 * 所以身份里不能带具体主机名，否则换一次入口就是一次全量重算。
 */
const ALIEXPRESS_MEDIA_HOST = /(^|\.)(alicdn\.com|aliexpress-media\.com)$/i;

/** 统一后的主机标记：只对上面的 CDN 家族生效，其它站点保留真实主机。 */
const ALIEXPRESS_HOST_MARKER = 'ae-cdn';

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

/**
 * 缓存身份用的规范化：在 `normalizeImageUrl` 之上，把 AliExpress CDN 的镜像主机折叠掉。
 *
 * 与 `normalizeImageUrl` 的差别只有一个 —— 那个要保留主机（页面内去重不该把两个站点的图
 * 混成一张），这个不能保留（同一张 `kf/S986e…l.jpg` 从哪个镜像来都是同一张购物图）。
 * 无法解析时返回 ''，调用方自己决定回落到什么。
 */
export function canonicalImageUrl(raw: unknown): string {
  const normalised = normalizeImageUrl(raw);
  if (!normalised) return '';

  const match = /^(https?):\/\/([^/]+)(\/.*)?$/i.exec(normalised);
  if (!match) return normalised;
  const [, protocol, host, pathname = '/'] = match;
  const canonicalHost = ALIEXPRESS_MEDIA_HOST.test(host) ? ALIEXPRESS_HOST_MARKER : host;
  return `${protocol}://${canonicalHost}${pathname}`;
}
