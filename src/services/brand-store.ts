/**
 * Brand registry storage.
 *
 * Logo payloads live in the shared IndexedDB `blobs` store (id prefix
 * `brand-logo-`), metadata in `chrome.storage.local` — the same split as
 * `watermark-store.ts`, for the same reason: both the Options page and the
 * editor read it directly on the same origin.
 */

import {
  BRAND_BLOB_PREFIX,
  BRAND_LOGO_MIME_TYPES,
  MAX_BRAND_LOGO_BYTES,
  STORAGE_KEYS,
} from '../shared/constants';
import { AppError, ErrorCode, messageOf } from '../shared/errors';
import type { BrandMeta } from '../shared/types';
import { deleteBlob, getBlob, putBlob } from './indexed-db';
import { readBlobSize } from './image-size';

export function isSupportedBrandLogoType(type: string): boolean {
  if (!type) return true; // the extension already restricts the file picker
  return (BRAND_LOGO_MIME_TYPES as readonly string[]).includes(type);
}

function createBrandId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${BRAND_BLOB_PREFIX}${Date.now().toString(36)}-${random}`;
}

/** Split a comma/space separated keyword string into a clean list. */
export function parseBrandTerms(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[,，、;；\s]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  );
}

/**
 * Read back the `aliases` field that entries stored before 10.10.0 still carry.
 *
 * Those entries were written when the name and the aliases both took part in
 * title matching. Dropping the field on read would silently narrow the matching,
 * so the words move into `keywords` instead — same detection, one list.
 */
function foldLegacyTerms(keywords: unknown, aliases: unknown): string[] {
  const list = Array.isArray(keywords) ? keywords.filter((entry) => typeof entry === 'string') : [];
  if (!Array.isArray(aliases)) return list;
  const seen = new Set(list);
  for (const entry of aliases) {
    if (typeof entry !== 'string') continue;
    const term = entry.trim();
    // Skip anything already there: a re-read must not keep growing the list.
    if (term && !seen.has(term)) {
      seen.add(term);
      list.push(term);
    }
  }
  return list;
}

function isBrandMeta(value: unknown): value is BrandMeta {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BrandMeta>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.logoBlobId === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number'
  );
}

/** All configured brands, oldest first. Never throws. */
export async function listBrands(): Promise<BrandMeta[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.brands);
    const value = stored?.[STORAGE_KEYS.brands] as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(isBrandMeta)
      .map((entry) => {
        // `aliases` is gone as of 10.10.0; entries written before that keep
        // their words by having them folded into `keywords` on every read.
        const { aliases: legacyAliases, ...rest } = entry as BrandMeta & { aliases?: unknown };
        return { ...rest, keywords: foldLegacyTerms(rest.keywords, legacyAliases) };
      })
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
  } catch {
    return [];
  }
}

async function writeBrands(list: BrandMeta[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.brands]: list });
}

/** Store a new brand with its logo. */
export async function saveBrand(input: {
  file: Blob;
  name: string;
  keywords?: string[];
}): Promise<BrandMeta> {
  const { file, name } = input;
  if (!file || file.size === 0) {
    throw new AppError(ErrorCode.UNKNOWN, 'Logo 图片为空，请换一张');
  }
  if (file.size > MAX_BRAND_LOGO_BYTES) {
    const limit = Math.round(MAX_BRAND_LOGO_BYTES / 1024 / 1024);
    throw new AppError(
      ErrorCode.UNKNOWN,
      `Logo 图片过大（上限 ${limit}MB，当前 ${(file.size / 1024 / 1024).toFixed(1)}MB）`,
    );
  }
  if (!isSupportedBrandLogoType(file.type)) {
    throw new AppError(ErrorCode.UNKNOWN, `不支持的 Logo 格式：${file.type}，请使用 PNG / JPEG / WebP`);
  }

  const size = await readBlobSize(file);
  if (size.width <= 0 || size.height <= 0) {
    throw new AppError(ErrorCode.UNKNOWN, '无法解析 Logo 图片尺寸，请换一张');
  }

  const list = await listBrands();
  const id = createBrandId();
  const meta: BrandMeta = {
    id,
    name: name.trim() || `品牌 ${list.length + 1}`,
    keywords: input.keywords ?? [],
    logoBlobId: id,
    width: size.width,
    height: size.height,
    createdAt: Date.now(),
    // Hand-uploaded brands are never touched by a catalog sync — see
    // `mergeRemoteBrands` and the `source` field in `shared/types.ts`.
    source: 'local',
  };

  try {
    await putBlob(id, file);
  } catch (error) {
    throw new AppError(ErrorCode.STORE_FAILED, `保存 Logo 图片失败：${messageOf(error)}`);
  }
  await writeBrands([...list, meta]);
  return meta;
}

export async function updateBrand(
  id: string,
  patch: Partial<Pick<BrandMeta, 'name' | 'keywords'>>,
): Promise<BrandMeta[]> {
  const list = await listBrands();
  const next = list.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          name: patch.name !== undefined ? patch.name.trim() || entry.name : entry.name,
          keywords: patch.keywords ?? entry.keywords,
          /*
            改完不标记任何"本地优先"状态（10.21.0）。以前这里会写 `edited: true`，
            让下一次目录同步保留本次措辞 —— 那等于同一个品牌有两套内容来源，谁赢取决于
            一个隐藏标记。现在的口径是：本机改动立刻生效，目录出了新版本就把这一行盖掉。
            想长期保留就改进目录（`catalog/brands.json`），或者把这个品牌从目录里拿掉。
          */
        }
      : entry,
  );
  await writeBrands(next);
  return next;
}

/** Remove a brand and its logo blob. */
export async function removeBrand(id: string): Promise<BrandMeta[]> {
  const list = await listBrands();
  const target = list.find((entry) => entry.id === id);
  const next = list.filter((entry) => entry.id !== id);
  await writeBrands(next);
  if (target) {
    // A leftover blob is harmless: it is never referenced again.
    await deleteBlob(target.logoBlobId).catch(() => undefined);
  }
  return next;
}

export async function loadBrandLogo(meta: BrandMeta): Promise<Blob | null> {
  return getBlob(meta.logoBlobId).catch(() => null);
}

/**
 * The one place a catalog sync writes the registry.
 *
 * Called once per sync with the whole delta, so a partial download cannot leave
 * the list half-updated. Two rules:
 *
 * - An existing entry keeps its `createdAt` (list order is "oldest first", and a
 *   brand jumping to the bottom of the Options page every day is noise).
 * - **目录即新版本**（10.21.0）：同名 id 的条目整条被目录内容覆盖 —— 名称、关键词、
 *   Logo、`remoteRev` 全部换成目录里的那一份。不再有 `edited` 豁免，也不再区分
 *   「手工上传」和「目录同步」：本机改了就是改了，目录下次发版就会盖掉它。
 *   想长期保留改动 → 改进目录；想让它彻底消失 → 从目录里删掉这一条。
 * - Removed entries lose their registry row but NOT their blob: a saved
 *   composition may still reference that logo layer, and a dangling blob id
 *   renders as an empty image.
 */
export async function mergeRemoteBrands(input: {
  upserts: BrandMeta[];
  removeIds: string[];
}): Promise<BrandMeta[]> {
  const list = await listBrands();
  const remove = new Set(input.removeIds);
  const kept = list.filter((entry) => !remove.has(entry.id));
  const position = new Map(kept.map((entry, index) => [entry.id, index]));
  const existingById = new Map(list.map((entry) => [entry.id, entry]));

  const merged = [...kept];
  for (const upsert of input.upserts) {
    const existing = existingById.get(upsert.id);
    const entry: BrandMeta = existing
      ? { ...upsert, createdAt: existing.createdAt }
      : upsert;
    const at = position.get(upsert.id);
    if (at === undefined) merged.push(entry);
    else merged[at] = entry;
  }

  await writeBrands(merged);
  return merged;
}

/**
 * Every string that identifies a brand in a product title.
 *
 * Only `keywords` — the name is for telling brands apart, not for claiming a
 * title. A brand called「魔方」/「三零」/「X社」would otherwise match titles that
 * have nothing to do with it, and the seller never gets a chance to notice.
 * Want the display name to count too? Put it in the keyword list as well.
 */
export function brandTerms(brand: BrandMeta): string[] {
  return brand.keywords;
}

/** Which brand claimed a title, and the keyword that did it. */
export interface BrandTitleMatch {
  brand: BrandMeta;
  /** The keyword that appears in the title (original spelling, not lower-cased). */
  term: string;
}

/** ASCII letters and digits glue two words together in a product title. */
const WORD_CHAR = /[a-z0-9]/;

/**
 * Does `term` appear in `title` as a **whole word**?
 *
 * Plain substring matching is wrong for Latin keywords: `Fans` sits inside
 * `FansHobby`, `Hasbro` inside `HasbroStudio`, `threezero` inside `threezeroes`
 * — different brands, same letters. So an ASCII keyword only counts when the
 * character before and after it are not letters/digits (`Fans Toys`, `Fans,`,
 * `Fans-`). Chinese has no word boundaries: 「银河社」inside「现货银河社变形玩具」is
 * the brand, so CJK-only keywords keep the substring rule.
 */
export function termMatchesTitle(title: string, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return false;
  const haystack = title.toLowerCase();
  if (!haystack) return false;

  const first = needle[0] ?? '';
  const last = needle[needle.length - 1] ?? '';
  const needLeft = WORD_CHAR.test(first);
  const needRight = WORD_CHAR.test(last);
  // No ASCII letters at all → no word boundaries to respect.
  if (!needLeft && !needRight) return haystack.includes(needle);

  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at > 0 ? (haystack[at - 1] ?? '') : '';
    const after = haystack[at + needle.length] ?? '';
    const leftOk = !needLeft || !WORD_CHAR.test(before);
    const rightOk = !needRight || !WORD_CHAR.test(after);
    if (leftOk && rightOk) return true;
    // Keep scanning: `Fans` may appear glued once and stand alone later.
    from = at + 1;
  }
}

/**
 * First brand whose any term appears in the title, plus the term that matched.
 *
 * The term matters: a match on a short keyword is easy to get wrong ("FT" / "MP"
 * / "Doc" all sit inside ordinary figure titles), and "为什么这个标题命中了这个
 * 品牌" is unanswerable from the brand name alone. Callers surface it so the
 * seller can see — and fix — the keyword instead of guessing.
 */
export function matchBrandByTitleDetailed(
  brands: readonly BrandMeta[],
  title: string,
): BrandTitleMatch | null {
  for (const brand of brands) {
    for (const term of brandTerms(brand)) {
      if (termMatchesTitle(title, term)) return { brand, term };
    }
  }
  return null;
}

/**
 * First brand whose any term appears in the title (case-insensitive).
 * `null` means "no opinion" — the editor then asks the user instead.
 */
export function matchBrandByTitle(brands: readonly BrandMeta[], title: string): BrandMeta | null {
  return matchBrandByTitleDetailed(brands, title)?.brand ?? null;
}
