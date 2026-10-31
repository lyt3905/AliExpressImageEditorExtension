/**
 * Executing a brand sync.
 *
 * The shape of this file follows one rule from the design: **a sync must never
 * leave the registry half-written.** Logos are downloaded and stored one by one
 * (a single bad PNG must not abort the others), but the registry is updated
 * exactly once at the end, so the editor never sees a brand pointing at a blob
 * that is not there yet.
 *
 * Every collaborator is a port with a production default, which is what lets
 * `tests/unit/brand-catalog-sync.test.ts` run in plain node without IndexedDB or
 * chrome.*.
 */

import type { BrandMeta } from '../../shared/types';
import { listBrands, mergeRemoteBrands } from '../brand-store';
import { readBlobSize } from '../image-size';
import { putBlob } from '../indexed-db';
import { downloadLogo, fetchBrandCatalog, type CatalogAttempt, type FetchLike } from './catalog-client';
import { planBrandSync, type BrandSyncPlan } from './sync-plan';
import {
  brandCatalogBaseUrls,
  loadBrandCatalogState,
  saveBrandCatalogState,
  type BrandCatalogState,
} from './state';
import type { BrandCatalog } from './schema';

export interface BrandSyncFailure {
  slug: string;
  message: string;
}

export interface BrandSyncResult {
  plan: BrandSyncPlan;
  /** Slugs that made it into the registry. */
  added: string[];
  /** Registry ids dropped (their blobs stay). */
  removed: string[];
  failures: BrandSyncFailure[];
  /** Registry after the merge — the caller can re-render without re-reading. */
  brands: BrandMeta[];
  attempts: CatalogAttempt[];
}

export type BrandSyncOutcome =
  | { ok: true; result: BrandSyncResult }
  | { ok: false; error: string };

export interface SyncPorts {
  fetchCatalog?: (options: {
    baseUrls: readonly string[];
    fetchLike?: FetchLike;
  }) => Promise<{ catalog: BrandCatalog; baseUrl: string; attempts: CatalogAttempt[] }>;
  download?: (url: string) => Promise<Blob>;
  digest?: (blob: Blob) => Promise<string>;
  putBlob?: (id: string, blob: Blob) => Promise<void>;
  readSize?: (blob: Blob) => Promise<{ width: number; height: number }>;
  listBrands?: () => Promise<BrandMeta[]>;
  mergeBrands?: (input: { upserts: BrandMeta[]; removeIds: string[] }) => Promise<BrandMeta[]>;
  loadState?: () => Promise<BrandCatalogState>;
  saveState?: (state: BrandCatalogState) => Promise<void>;
  now?: () => number;
  fetchLike?: FetchLike;
}

export interface SyncBrandCatalogOptions {
  /** The Options page button means "now", not "in a day". */
  ignoreTtl?: boolean;
  /** Extra catalog URL to try before the built-in mirrors (a self-hosted copy). */
  extraBaseUrls?: readonly string[];
  ports?: SyncPorts;
}

async function defaultDigest(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Run one plan: fetch the bytes, then write the registry once. */
export async function applyBrandSync(
  plan: BrandSyncPlan,
  ports: SyncPorts = {},
): Promise<Pick<BrandSyncResult, 'added' | 'removed' | 'failures' | 'brands'>> {
  const download = ports.download ?? ((url: string) => downloadLogo(url));
  const digest = ports.digest ?? defaultDigest;
  const put = ports.putBlob ?? putBlob;
  const readSize = ports.readSize ?? readBlobSize;
  const merge = ports.mergeBrands ?? mergeRemoteBrands;
  const now = ports.now ?? Date.now;

  const upserts: BrandMeta[] = [];
  const added: string[] = [];
  const failures: BrandSyncFailure[] = [];

  for (const item of plan.toDownload) {
    try {
      const blob = await download(item.url);
      if (item.sha256) {
        const actual = await digest(blob);
        if (actual !== item.sha256.toLowerCase()) {
          throw new Error(`校验和不匹配（目录 ${item.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）`);
        }
      }
      const size = await readSize(blob);
      if (size.width <= 0 || size.height <= 0) throw new Error('无法解析图片尺寸');
      await put(item.logoBlobId, blob);
      upserts.push({
        id: item.brandId,
        name: item.name,
        keywords: item.keywords,
        logoBlobId: item.logoBlobId,
        width: size.width,
        height: size.height,
        createdAt: now(),
        source: 'remote',
        slug: item.slug,
        remoteRev: item.rev,
      });
      added.push(item.slug);
    } catch (error) {
      // One bad logo must not cost the others their sync.
      failures.push({ slug: item.slug, message: error instanceof Error ? error.message : String(error) });
    }
  }

  const brands = await merge({ upserts, removeIds: plan.toRemove });
  return { added, removed: plan.toRemove, failures, brands };
}

/**
 * The whole operation: read state → fetch → plan → apply → persist.
 *
 * Returns instead of throwing because "GitHub is unreachable" is an ordinary
 * outcome the Options page has to render, not an exceptional one. Today's
 * failure is remembered in `lastError` so the next editor start can tell the
 * seller why nothing updated.
 */
export async function syncBrandCatalog(
  options: SyncBrandCatalogOptions = {},
): Promise<BrandSyncOutcome> {
  const ports = options.ports ?? {};
  const fetchCatalog = ports.fetchCatalog ?? fetchBrandCatalog;
  const loadState = ports.loadState ?? loadBrandCatalogState;
  const saveState = ports.saveState ?? saveBrandCatalogState;
  const readBrands = ports.listBrands ?? listBrands;
  const now = ports.now ?? Date.now;

  const state = await loadState();
  const ttlState = options.ignoreTtl ? { ...state, syncedAt: 0 } : state;
  const baseUrls = mergeBaseUrls(options.extraBaseUrls ?? [], brandCatalogBaseUrls(state));

  let fetched: { catalog: BrandCatalog; baseUrl: string; attempts: CatalogAttempt[] };
  try {
    fetched = await fetchCatalog({ baseUrls, ...(ports.fetchLike ? { fetchLike: ports.fetchLike } : {}) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveState({ ...state, lastError: message }).catch(() => undefined);
    return { ok: false, error: message };
  }

  const localBrands = await readBrands();
  const plan = planBrandSync({
    catalog: fetched.catalog,
    baseUrl: fetched.baseUrl,
    localBrands,
    state: ttlState,
    now: now(),
  });

  const applied = await applyBrandSync(plan, ports);
  const failures = applied.failures;

  // The version is only advanced when the whole catalog landed: a partial run
  // must retry the missing logos next time, and the cheap `rev` comparison
  // already keeps the retry to just those.
  const complete = failures.length === 0 && applied.added.length === plan.toDownload.length;
  const next: BrandCatalogState = {
    version: complete ? fetched.catalog.version : state.version,
    syncedAt: now(),
    baseUrlUsed: fetched.baseUrl,
    lastError: failures.length > 0 ? `${failures.length} 个品牌同步失败` : null,
  };
  await saveState(next).catch(() => undefined);

  return {
    ok: true,
    result: { plan, ...applied, attempts: fetched.attempts },
  };
}

/**
 * Prepend the seller's own catalog URL to the mirror list, without duplicates.
 *
 * The last-used mirror goes right after it: if the self-hosted copy is down, the
 * run still falls back to whatever worked before rather than starting over.
 */
function mergeBaseUrls(extra: readonly string[], base: readonly string[]): string[] {
  return [...new Set([...extra, ...base])];
}
