/**
 * Single source of truth for "which page may this extension act on".
 *
 * The same answer is needed in three places: the service worker (before it
 * scans), the page adapter (before it reads the DOM) and `content_scripts.matches`
 * in manifest.json. Each used to carry its own copy of the rule — which is how
 * `host_permissions` came to grant `aliexpress.us` while every code path
 * rejected it, and how a click on a non-web page produced a message blaming the
 * user for "not being on AliExpress" while throwing away the one useful clue:
 * the URL that was actually inspected.
 */

/**
 * Seller console host. This is the browser-side counterpart of
 * `content_scripts.matches` in manifest.json — keep the two in sync.
 */
export const SELLER_HOST_PATTERN = /(^|\.)aliexpress\.com$/i;

/**
 * AliExpress runs a separate site per market (`aliexpress.us`, `.ru`, `.es` …).
 * Those hosts are recognised only so we can say what we actually found, instead
 * of claiming the user is not on AliExpress at all.
 */
const OTHER_LOCALE_HOST_PATTERN = /(^|\.)aliexpress\.(?!com$)[a-z]{2,4}$/i;

/** Phrase reused by every rejection so the wording cannot drift apart. */
export const SUPPORTED_PAGE_DESCRIPTION = 'AliExpress 卖家后台（aliexpress.com）的商品编辑页';

export type PageGateRejectionReason =
  | 'NO_TAB_URL'
  | 'NOT_A_WEB_PAGE'
  | 'EXTENSION_PAGE'
  | 'OTHER_LOCALE_HOST'
  | 'NOT_ALIEXPRESS';

export interface PageGateRejection {
  ok: false;
  reason: PageGateRejectionReason;
  /** Exactly what we were handed, kept verbatim so a log line can show it. */
  rawUrl: string;
  /** Hostname when the URL parsed, otherwise ''. */
  host: string;
  /** Ready to show to the user. */
  message: string;
}

export interface PageGateAcceptance {
  ok: true;
  url: URL;
  host: string;
}

export type PageGateResult = PageGateAcceptance | PageGateRejection;

function reject(
  reason: PageGateRejectionReason,
  rawUrl: string,
  host: string,
  message: string,
): PageGateRejection {
  return { ok: false, reason, rawUrl, host, message };
}

/**
 * Decide whether a raw (usually `chrome.tabs.Tab.url`) value points at a page
 * we can scan. Never throws — an unsupported input is a normal outcome, not an
 * exception, so callers can turn it into a user-facing message.
 */
export function evaluatePageGate(rawUrl: string | null | undefined): PageGateResult {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!raw) {
    // Hitting this branch means the gate was handed no URL at all, which has
    // nothing to do with "which site the user is on".
    return reject(
      'NO_TAB_URL',
      raw,
      '',
      `读取不到当前标签页的地址，无法判断在哪里扫描商品图片。请先把 ${SUPPORTED_PAGE_DESCRIPTION} 切到前台，再点击插件图标。`,
    );
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return reject(
      'NOT_A_WEB_PAGE',
      raw,
      '',
      `当前标签页地址无法解析（${raw}）。请先打开 ${SUPPORTED_PAGE_DESCRIPTION}。`,
    );
  }

  const scheme = url.protocol.replace(/:$/, '').toLowerCase();

  if (scheme === 'chrome-extension' || scheme === 'moz-extension') {
    return reject(
      'EXTENSION_PAGE',
      raw,
      url.hostname,
      `当前标签页是插件自己的页面（编辑器或设置页），不是商品页。请切换回 ${SUPPORTED_PAGE_DESCRIPTION} 再点击插件图标。`,
    );
  }
  if (scheme !== 'http' && scheme !== 'https') {
    return reject(
      'NOT_A_WEB_PAGE',
      raw,
      url.hostname,
      `当前标签页不是普通网页（${scheme}://…），插件无法在其中读取商品图片。请先打开 ${SUPPORTED_PAGE_DESCRIPTION}。`,
    );
  }

  const host = url.hostname.toLowerCase();
  if (SELLER_HOST_PATTERN.test(host)) {
    return { ok: true, url, host };
  }
  if (OTHER_LOCALE_HOST_PATTERN.test(host)) {
    return reject(
      'OTHER_LOCALE_HOST',
      raw,
      host,
      `检测到 AliExpress 的其他地区站点（${host}），当前版本只支持 ${SUPPORTED_PAGE_DESCRIPTION}。`,
    );
  }
  return reject(
    'NOT_ALIEXPRESS',
    raw,
    host,
    `当前页面不是 ${SUPPORTED_PAGE_DESCRIPTION}（当前站点：${host}）。`,
  );
}

/** Boolean shorthand for callers that do not need the reason. */
export function isSupportedPageUrl(rawUrl: string | null | undefined): boolean {
  return evaluatePageGate(rawUrl).ok;
}
