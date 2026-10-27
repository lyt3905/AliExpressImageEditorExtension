/**
 * Catalog sync bookkeeping.
 *
 * Small on purpose: the catalog version we last applied, when we last succeeded,
 * which mirror answered, and which slugs the seller unticked. The brands
 * themselves are NOT stored here — they live in the registry
 * (`brand-store.ts`), so the editor keeps reading exactly one list.
 */

import { BRAND_CATALOG_URLS, STORAGE_KEYS } from '../../shared/constants';

export interface BrandCatalogState {
  /** Catalog `version` last applied in full. 0 = never synced. */
  version: number;
  /** Timestamp of the last fully successful sync. 0 = never. */
  syncedAt: number;
  /** Mirror that answered last time; tried first on the next run. */
  baseUrlUsed: string | null;
  /** Slugs the seller does not want synced. */
  skipped: string[];
  /** Last failure message, cleared by the next success. Shown in the Options page. */
  lastError: string | null;
}

export const EMPTY_CATALOG_STATE: BrandCatalogState = {
  version: 0,
  syncedAt: 0,
  baseUrlUsed: null,
  skipped: [],
  lastError: null,
};

function normalizeState(value: unknown): BrandCatalogState {
  if (!value || typeof value !== 'object') return { ...EMPTY_CATALOG_STATE };
  const candidate = value as Partial<BrandCatalogState>;
  return {
    version: typeof candidate.version === 'number' ? candidate.version : 0,
    syncedAt: typeof candidate.syncedAt === 'number' ? candidate.syncedAt : 0,
    baseUrlUsed: typeof candidate.baseUrlUsed === 'string' ? candidate.baseUrlUsed : null,
    skipped: Array.isArray(candidate.skipped)
      ? candidate.skipped.filter((entry): entry is string => typeof entry === 'string')
      : [],
    lastError: typeof candidate.lastError === 'string' ? candidate.lastError : null,
  };
}

export async function loadBrandCatalogState(): Promise<BrandCatalogState> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.brandCatalog);
    return normalizeState(stored?.[STORAGE_KEYS.brandCatalog]);
  } catch {
    return { ...EMPTY_CATALOG_STATE };
  }
}

export async function saveBrandCatalogState(state: BrandCatalogState): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.brandCatalog]: normalizeState(state),
  });
}

/** Tick / untick one slug in the Options page. Returns the saved state. */
export async function setBrandCatalogSkipped(
  slug: string,
  skipped: boolean,
): Promise<BrandCatalogState> {
  const state = await loadBrandCatalogState();
  const set = new Set(state.skipped);
  if (skipped) set.add(slug);
  else set.delete(slug);
  const next: BrandCatalogState = { ...state, skipped: [...set] };
  await saveBrandCatalogState(next);
  return next;
}

/**
 * Mirror order for the next run: the one that worked last time first, then the
 * built-in defaults. A remembered mirror that has since stopped answering simply
 * falls through to the next entry.
 */
export function brandCatalogBaseUrls(state: BrandCatalogState): string[] {
  const ordered = state.baseUrlUsed ? [state.baseUrlUsed, ...BRAND_CATALOG_URLS] : [...BRAND_CATALOG_URLS];
  return [...new Set(ordered)];
}
