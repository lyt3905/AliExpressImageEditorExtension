/**
 * What a sync would do — decided without touching the network or storage.
 *
 * The registry in `chrome.storage.local` + IndexedDB is the source of truth; the
 * catalog is an input. So this function answers one question: given what we have
 * and what the catalog says, which logos need downloading, which registry rows
 * need removing, and which are already fine?
 *
 * Being pure is the point: every rule below (TTL, version short-circuit, per-brand
 * `rev`, "a hand-uploaded brand always wins", "a skipped brand is left alone") is
 * a line of the user-visible contract and has a test that reads like it.
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
  aliases: string[];
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
  /** Slugs the seller unticked in the Options page. */
  skipped: string[];
  /** Slugs a hand-uploaded brand already covers (same name, case-insensitive). */
  conflicts: string[];
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
    skipped: [] as string[],
    conflicts: [] as string[],
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
  // A brand the seller uploaded by hand owns its name: the catalog cannot shadow
  // it, because the local logo is what that seller actually wants on the canvas.
  const localNames = new Set(
    localBrands
      .filter((brand) => brand.source !== 'remote')
      .map((brand) => normalizeName(brand.name)),
  );
  const skipped = new Set(state.skipped);
  const catalogSlugs = new Set(catalog.brands.map((brand) => brand.id));

  for (const brand of catalog.brands) {
    if (skipped.has(brand.id)) {
      base.skipped.push(brand.id);
      continue;
    }
    if (localNames.has(normalizeName(brand.name))) {
      base.conflicts.push(brand.id);
      continue;
    }
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
      aliases: brand.aliases,
      keywords: brand.keywords,
      url: resolveLogoUrl(baseUrl, brand.logo.file),
      rev: brand.rev,
      ...(brand.logo.sha256 ? { sha256: brand.logo.sha256 } : {}),
    });
  }

  for (const brand of localRemote) {
    const slug = brand.slug as string;
    // A skipped brand is kept as-is: unticking it means "leave this one alone",
    // not "remove it".
    if (catalogSlugs.has(slug) || skipped.has(slug)) continue;
    base.toRemove.push(brand.id);
  }

  return { ...base, reason: 'sync' };
}
