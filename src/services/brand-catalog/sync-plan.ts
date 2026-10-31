/**
 * What a sync would do — decided without touching the network or storage.
 *
 * The registry in `chrome.storage.local` + IndexedDB is the source of truth; the
 * catalog is an input. So this function answers one question: given what we have
 * and what the catalog says, which logos need downloading, which registry rows
 * need removing, and which are already fine?
 *
 * Being pure is the point: every rule below (TTL, version short-circuit, per-brand
 * `rev`, "the catalog wins when it publishes a new version") is a line of the
 * user-visible contract and has a test that reads like it.
 *
 * 10.21.0 起不再区分「手工上传」和「目录同步」：目录里有的品牌一律以目录为准，
 * 包括把同名的那个手工品牌删掉（否则下拉框里会出现两个同名品牌）。
 */

import { BRAND_CATALOG_TTL_MS } from '../../shared/constants';
import type { BrandMeta } from '../../shared/types';
import { remoteBrandId, remoteLogoBlobId, resolveLogoUrl, type BrandCatalog } from './schema';
import type { BrandCatalogState } from './state';

/** One logo the sync has to fetch, pre-resolved so the executor only does IO. */
export interface CatalogSyncItem {
  slug: string;
  /** Registry id (`remote-<slug>`). */
  brandId: string;
  /** IndexedDB blob id (`brand-logo-remote-<slug>`). */
  logoBlobId: string;
  name: string;
  keywords: string[];
  /** Absolute, validated URL. */
  url: string;
  /** Fingerprint this item is downloaded for. */
  rev: string;
  sha256?: string;
}

export type SyncReason =
  /** Last successful sync is inside the TTL window — do not even go online. */
  | 'fresh'
  /** Catalog version equals the synced one — nothing changed upstream. */
  | 'up-to-date'
  /** There is work (possibly none left after the per-brand comparison). */
  | 'sync';

export interface BrandSyncPlan {
  reason: SyncReason;
  toDownload: CatalogSyncItem[];
  /** Registry ids to drop. Their blobs stay on purpose — see `sync.ts`. */
  toRemove: string[];
  unchanged: string[];
  version: number;
}

export interface PlanBrandSyncInput {
  catalog: BrandCatalog;
  /** Catalog directory URL the manifest came from; logos resolve against it. */
  baseUrl: string;
  localBrands: readonly BrandMeta[];
  state: BrandCatalogState;
  now: number;
  ttlMs?: number;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

export function planBrandSync(input: PlanBrandSyncInput): BrandSyncPlan {
  const { catalog, baseUrl, localBrands, state, now } = input;
  const ttl = input.ttlMs ?? BRAND_CATALOG_TTL_MS;
  const base = {
    toDownload: [] as CatalogSyncItem[],
    toRemove: [] as string[],
    unchanged: [] as string[],
    version: catalog.version,
  };

  if (state.syncedAt > 0 && now - state.syncedAt < ttl) {
    return { ...base, reason: 'fresh' };
  }
  // The version is the change signal. It is written only after a fully successful
  // sync, so "same version" really means "nothing to do" — a half-finished run
  // keeps the old version and retries next time.
  if (state.syncedAt > 0 && state.version === catalog.version) {
    return { ...base, reason: 'up-to-date' };
  }

  const localRemote = localBrands.filter(
    (brand) => brand.source === 'remote' && typeof brand.slug === 'string',
  );
  const localRemoteBySlug = new Map(localRemote.map((brand) => [brand.slug as string, brand]));
  const catalogSlugs = new Set(catalog.brands.map((brand) => brand.id));
  const catalogNames = new Set(catalog.brands.map((brand) => normalizeName(brand.name)));

  for (const brand of catalog.brands) {
    const existing = localRemoteBySlug.get(brand.id);
    if (existing && existing.remoteRev === brand.rev) {
      base.unchanged.push(brand.id);
      continue;
    }
    base.toDownload.push({
      slug: brand.id,
      brandId: remoteBrandId(brand.id),
      logoBlobId: remoteLogoBlobId(brand.id),
      name: brand.name,
      keywords: brand.keywords,
      url: resolveLogoUrl(baseUrl, brand.logo.file),
      rev: brand.rev,
      ...(brand.logo.sha256 ? { sha256: brand.logo.sha256 } : {}),
    });
  }

  for (const brand of localRemote) {
    const slug = brand.slug as string;
    if (catalogSlugs.has(slug)) continue;
    // 目录里已经没有这一条 → 删掉本机这行（blob 留着，历史画布还引用着）。
    base.toRemove.push(brand.id);
  }

  /*
    同名的本机品牌（手工上传的那条，或目录里改过名的旧行）被目录版本取代：不删的话
    下拉框里会出现两个一模一样的中文名，而"哪个在生效"永远说不清。手工上传的 blob
    留不留？留 —— 删行不删图，和文件里的既有约定一致。
  */
  for (const brand of localBrands) {
    if (brand.source === 'remote') continue;
    if (!catalogNames.has(normalizeName(brand.name))) continue;
    base.toRemove.push(brand.id);
  }

  return { ...base, reason: 'sync' };
}
