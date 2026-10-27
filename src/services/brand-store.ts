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

/** Split a comma/space separated alias string into a clean list. */
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
      .map((entry) => ({
        ...entry,
        aliases: Array.isArray(entry.aliases) ? entry.aliases : [],
        keywords: Array.isArray(entry.keywords) ? entry.keywords : [],
      }))
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
  aliases?: string[];
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
    aliases: input.aliases ?? [],
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
  patch: Partial<Pick<BrandMeta, 'name' | 'aliases' | 'keywords'>>,
): Promise<BrandMeta[]> {
  const list = await listBrands();
  const next = list.map((entry) =>
    entry.id === id
      ? {
          ...entry,
          name: patch.name !== undefined ? patch.name.trim() || entry.name : entry.name,
          aliases: patch.aliases ?? entry.aliases,
          keywords: patch.keywords ?? entry.keywords,
          // A renamed/retagged catalog brand keeps the seller's wording: the
          // next sync refreshes its logo but must not undo these edits.
          ...(entry.source === 'remote' ? { edited: true } : {}),
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
 * the list half-updated. Three rules:
 *
 * - An existing entry keeps its `createdAt` (list order is "oldest first", and a
 *   brand jumping to the bottom of the Options page every day is noise).
 * - A remote entry the seller renamed or retagged keeps that wording — only the
 *   logo and `remoteRev` are refreshed.
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
  // Only catalog brands may be removed by a sync; a local brand sharing the id
  // (impossible today, cheap to guarantee) is left alone.
  const kept = list.filter((entry) => !(remove.has(entry.id) && entry.source === 'remote'));
  const position = new Map(kept.map((entry, index) => [entry.id, index]));
  const existingById = new Map(list.map((entry) => [entry.id, entry]));

  const merged = [...kept];
  for (const upsert of input.upserts) {
    const existing = existingById.get(upsert.id);
    const entry: BrandMeta = existing
      ? {
          ...upsert,
          createdAt: existing.createdAt,
          ...(existing.edited
            ? {
                name: existing.name,
                aliases: existing.aliases,
                keywords: existing.keywords,
                edited: true,
              }
            : {}),
        }
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
 * Name and aliases count too — a brand named "Hasbro" matches a title saying
 * "Hasbro" without the seller repeating it in the keyword box.
 */
export function brandTerms(brand: BrandMeta): string[] {
  return [brand.name, ...brand.aliases, ...brand.keywords];
}

/**
 * First brand whose any term appears in the title (case-insensitive).
 * `null` means "no opinion" — the editor then asks the user instead.
 */
export function matchBrandByTitle(brands: readonly BrandMeta[], title: string): BrandMeta | null {
  const haystack = title.toLowerCase();
  for (const brand of brands) {
    for (const term of brandTerms(brand)) {
      if (term && haystack.includes(term.toLowerCase())) return brand;
    }
  }
  return null;
}
