import { describe, expect, it, vi } from 'vitest';
import type { BrandMeta } from '../../src/shared/types';
import type { BrandCatalog } from '../../src/services/brand-catalog/schema';
import type { BrandCatalogState } from '../../src/services/brand-catalog/state';
import { applyBrandSync, syncBrandCatalog, type SyncPorts } from '../../src/services/brand-catalog/sync';
import { planBrandSync } from '../../src/services/brand-catalog/sync-plan';
import { BRAND_CATALOG_TTL_MS, BRAND_CATALOG_URLS } from '../../src/shared/constants';

/**
 * Two rules carry most of the weight here and both are about *not* doing damage:
 *
 * - a sync never rewrites a brand the seller uploaded or renamed by hand;
 * - a sync never leaves the registry pointing at a blob that failed to download.
 */

const BASE = 'https://raw.githubusercontent.com/lyt3905/AliExpressImageEditorExtension/main/catalog/';
const NOW = 1_700_000_000_000;

function catalog(
  brands: Array<{ id: string; name?: string; rev?: string }>,
  version = 1,
): BrandCatalog {
  return {
    version,
    brands: brands.map((entry) => ({
      id: entry.id,
      name: entry.name ?? entry.id,
      aliases: [],
      keywords: [],
      logo: { file: `logos/${entry.id}.png` },
      rev: entry.rev ?? `v${version}`,
    })),
  };
}

function state(overrides: Partial<BrandCatalogState> = {}): BrandCatalogState {
  return { version: 0, syncedAt: 0, baseUrlUsed: null, skipped: [], lastError: null, ...overrides };
}

function localBrand(overrides: Partial<BrandMeta> = {}): BrandMeta {
  return {
    id: 'brand-logo-abc',
    name: 'Local Brand',
    aliases: [],
    keywords: [],
    logoBlobId: 'brand-logo-abc',
    width: 100,
    height: 50,
    createdAt: NOW,
    ...overrides,
  };
}

function remoteBrand(slug: string, rev: string, overrides: Partial<BrandMeta> = {}): BrandMeta {
  return {
    id: `remote-${slug}`,
    name: slug,
    aliases: [],
    keywords: [],
    logoBlobId: `brand-logo-remote-${slug}`,
    width: 100,
    height: 50,
    createdAt: NOW,
    source: 'remote',
    slug,
    remoteRev: rev,
    ...overrides,
  };
}

describe('planBrandSync', () => {
  it('does nothing at all inside the TTL window', () => {
    const plan = planBrandSync({
      catalog: catalog([{ id: 'a' }]),
      baseUrl: BASE,
      localBrands: [],
      state: state({ syncedAt: NOW - 1000, version: 0 }),
      now: NOW,
    });
    expect(plan.reason).toBe('fresh');
    expect(plan.toDownload).toEqual([]);
  });

  it('short-circuits when the catalog version did not move', () => {
    const plan = planBrandSync({
      catalog: catalog([{ id: 'a' }], 5),
      baseUrl: BASE,
      localBrands: [remoteBrand('a', 'v5')],
      state: state({ version: 5, syncedAt: NOW - BRAND_CATALOG_TTL_MS - 1 }),
      now: NOW,
    });
    expect(plan.reason).toBe('up-to-date');
  });

  it('downloads everything on a first sync, with absolute logo URLs', () => {
    const plan = planBrandSync({
      catalog: catalog([{ id: 'a' }, { id: 'b' }]),
      baseUrl: BASE,
      localBrands: [],
      state: state(),
      now: NOW,
    });
    expect(plan.reason).toBe('sync');
    expect(plan.toDownload.map((item) => item.slug)).toEqual(['a', 'b']);
    expect(plan.toDownload[0]).toMatchObject({
      brandId: 'remote-a',
      logoBlobId: 'brand-logo-remote-a',
      url: `${BASE}logos/a.png`,
    });
  });

  it('re-downloads only the brands whose rev changed', () => {
    const plan = planBrandSync({
      catalog: catalog([{ id: 'a', rev: 'r1' }, { id: 'b', rev: 'r2' }], 2),
      baseUrl: BASE,
      localBrands: [remoteBrand('a', 'r1'), remoteBrand('b', 'old')],
      state: state({ version: 1, syncedAt: NOW - BRAND_CATALOG_TTL_MS - 1 }),
      now: NOW,
    });
    expect(plan.unchanged).toEqual(['a']);
    expect(plan.toDownload.map((item) => item.slug)).toEqual(['b']);
  });

  it('lets a hand-uploaded brand win over the catalog', () => {
    const plan = planBrandSync({
      catalog: catalog([{ id: 'morph-toys', name: 'Morph Toys' }]),
      baseUrl: BASE,
      localBrands: [localBrand({ name: ' morph toys ' })],
      state: state(),
      now: NOW,
    });
    // Same name, different case and padding — still a conflict, and nothing is
    // downloaded for it, so the seller's own logo stays on the canvas.
    expect(plan.conflicts).toEqual(['morph-toys']);
    expect(plan.toDownload).toEqual([]);
  });

  it('leaves unticked brands alone: no download, and no removal either', () => {
    const plan = planBrandSync({
      catalog: catalog([{ id: 'keep' }, { id: 'skip-me' }]),
      baseUrl: BASE,
      localBrands: [remoteBrand('skip-me', 'old'), remoteBrand('gone', 'v1')],
      state: state({ skipped: ['skip-me', 'gone'] }),
      now: NOW,
    });
    expect(plan.skipped).toEqual(['skip-me']);
    expect(plan.toDownload.map((item) => item.slug)).toEqual(['keep']);
    expect(plan.toRemove).toEqual([]);
  });

  it('removes catalog brands that disappeared upstream, keeping local ones', () => {
    const plan = planBrandSync({
      catalog: catalog([{ id: 'still-there' }]),
      baseUrl: BASE,
      localBrands: [remoteBrand('still-there', 'v1'), remoteBrand('gone', 'v1'), localBrand()],
      state: state({ version: 9 }),
      now: NOW,
    });
    expect(plan.toRemove).toEqual(['remote-gone']);
  });

  it('honours an explicit ttl override', () => {
    const plan = planBrandSync({
      catalog: catalog([{ id: 'a' }], 2),
      baseUrl: BASE,
      localBrands: [],
      state: state({ version: 1, syncedAt: NOW - 1 }),
      now: NOW,
      ttlMs: 0,
    });
    expect(plan.reason).toBe('sync');
  });
});

interface Harness extends SyncPorts {
  putBlob: ReturnType<typeof vi.fn>;
  mergeBrands: ReturnType<typeof vi.fn>;
}

function harness(overrides: SyncPorts = {}): Harness {
  const putBlob = (overrides.putBlob ?? vi.fn(async () => undefined)) as ReturnType<typeof vi.fn>;
  const mergeBrands = (overrides.mergeBrands ??
    vi.fn(async ({ upserts }: { upserts: BrandMeta[] }) => upserts)) as ReturnType<typeof vi.fn>;
  return {
    download: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    digest: async () => 'a'.repeat(64),
    readSize: async () => ({ width: 100, height: 50 }),
    now: () => NOW,
    ...overrides,
    putBlob,
    mergeBrands,
  };
}

describe('applyBrandSync', () => {
  function plan(overrides: Partial<Parameters<typeof planBrandSync>[0]> = {}) {
    return planBrandSync({
      catalog: catalog([{ id: 'a', name: 'Brand A', rev: 'r1' }]),
      baseUrl: BASE,
      localBrands: [],
      state: state(),
      now: NOW,
      ...overrides,
    });
  }

  it('stores the blob, then writes the registry exactly once', async () => {
    const ports = harness();
    const result = await applyBrandSync(plan(), ports);

    expect(ports.putBlob).toHaveBeenCalledWith('brand-logo-remote-a', expect.anything());
    expect(ports.mergeBrands).toHaveBeenCalledTimes(1);
    expect(ports.mergeBrands).toHaveBeenCalledWith({
      upserts: [
        expect.objectContaining({
          id: 'remote-a',
          name: 'Brand A',
          source: 'remote',
          slug: 'a',
          remoteRev: 'r1',
          width: 100,
          height: 50,
        }),
      ],
      removeIds: [],
    });
    expect(result.added).toEqual(['a']);
    expect(result.failures).toEqual([]);
  });

  it('keeps going when one logo fails, and still writes the rest', async () => {
    const ports = harness({
      download: async (url: string) => {
        if (url.includes('/b.png')) throw new Error('HTTP 404');
        return new Blob([new Uint8Array([1])], { type: 'image/png' });
      },
    });
    const result = await applyBrandSync(
      plan({ catalog: catalog([{ id: 'a' }, { id: 'b' }]) }),
      ports,
    );
    expect(result.added).toEqual(['a']);
    expect(result.failures).toEqual([{ slug: 'b', message: 'HTTP 404' }]);
    expect(ports.putBlob).toHaveBeenCalledTimes(1);
  });

  it('rejects a logo whose bytes do not match the advertised sha256', async () => {
    const ports = harness({ digest: async () => 'b'.repeat(64) });
    const result = await applyBrandSync(
      plan({
        catalog: {
          version: 1,
          brands: [
            {
              id: 'a',
              name: 'A',
              aliases: [],
              keywords: [],
              logo: { file: 'logos/a.png', sha256: 'c'.repeat(64) },
              rev: 'r1',
            },
          ],
        },
      }),
      ports,
    );
    expect(result.added).toEqual([]);
    expect(result.failures[0].message).toContain('校验和不匹配');
    expect(ports.putBlob).not.toHaveBeenCalled();
  });

  it('rejects an image it cannot measure', async () => {
    const ports = harness({ readSize: async () => ({ width: 0, height: 0 }) });
    const result = await applyBrandSync(plan(), ports);
    expect(result.failures[0].message).toContain('尺寸');
    expect(ports.putBlob).not.toHaveBeenCalled();
  });
});

interface SyncHarness {
  ports: SyncPorts;
  saved: BrandCatalogState[];
}

function syncHarness(options: {
  catalog?: BrandCatalog;
  localBrands?: BrandMeta[];
  state?: BrandCatalogState;
  failFetch?: boolean;
  failLogo?: boolean;
} = {}): SyncHarness {
  const saved: BrandCatalogState[] = [];
  const ports: SyncPorts = {
    fetchCatalog: async () => {
      if (options.failFetch) throw new Error('没拿到品牌目录（raw.githubusercontent.com：HTTP 502）');
      return { catalog: options.catalog ?? catalog([{ id: 'a' }]), baseUrl: BASE, attempts: [] };
    },
    download: async () => {
      if (options.failLogo) throw new Error('HTTP 500');
      return new Blob([new Uint8Array([1, 2])], { type: 'image/png' });
    },
    digest: async () => 'a'.repeat(64),
    putBlob: async () => undefined,
    readSize: async () => ({ width: 100, height: 50 }),
    listBrands: async () => options.localBrands ?? [],
    mergeBrands: async ({ upserts, removeIds }) => [
      ...(options.localBrands ?? []).filter((entry) => !removeIds.includes(entry.id)),
      ...upserts,
    ],
    loadState: async () => options.state ?? state(),
    saveState: async (next) => {
      saved.push(next);
    },
    now: () => NOW,
  };
  return { ports, saved };
}

describe('syncBrandCatalog', () => {
  it('persists version, timestamp and mirror after a clean run', async () => {
    const { ports, saved } = syncHarness({ catalog: catalog([{ id: 'a' }], 7) });
    const outcome = await syncBrandCatalog({ ports });
    expect(outcome.ok).toBe(true);
    expect(saved).toEqual([
      {
        version: 7,
        syncedAt: NOW,
        baseUrlUsed: BASE,
        skipped: [],
        lastError: null,
      },
    ]);
  });

  it('reports a dead catalog without touching the registry', async () => {
    const { ports, saved } = syncHarness({ failFetch: true });
    const outcome = await syncBrandCatalog({ ports });
    expect(outcome.ok).toBe(false);
    // The failure is remembered so the next editor start can explain itself.
    expect(saved[0].lastError).toContain('没拿到品牌目录');
    expect(saved[0].syncedAt).toBe(0);
  });

  it('does not advance the version when a logo failed', async () => {
    const { ports, saved } = syncHarness({
      catalog: catalog([{ id: 'a' }], 3),
      state: state({ version: 2, syncedAt: NOW - BRAND_CATALOG_TTL_MS - 1 }),
      failLogo: true,
    });
    const outcome = await syncBrandCatalog({ ports });
    expect(outcome.ok).toBe(true);
    // Keeping version 2 means the next run retries instead of believing it is done.
    expect(saved[0].version).toBe(2);
    expect(saved[0].lastError).toContain('失败');
  });

  it('bypasses the TTL when the seller clicks 立即同步', async () => {
    const { ports } = syncHarness({
      catalog: catalog([{ id: 'b' }], 2),
      state: state({ version: 1, syncedAt: NOW - 1000 }),
    });
    const fresh = await syncBrandCatalog({ ports });
    expect(fresh.ok && fresh.result.plan.reason).toBe('fresh');

    const forced = await syncBrandCatalog({ ports, ignoreTtl: true });
    expect(forced.ok && forced.result.plan.reason).toBe('sync');
  });

  it('tries the self-hosted mirror first, without dropping the built-in ones', async () => {
    const { ports } = syncHarness({ catalog: catalog([{ id: 'a' }], 4) });
    const seen: string[][] = [];
    ports.fetchCatalog = async (options) => {
      seen.push([...options.baseUrls]);
      return { catalog: catalog([{ id: 'a' }], 4), baseUrl: 'https://mine.test/catalog/', attempts: [] };
    };
    const outcome = await syncBrandCatalog({ ports, extraBaseUrls: ['https://mine.test/catalog/'] });
    expect(outcome.ok).toBe(true);
    // The seller's mirror is first, the built-in defaults still follow as fallback.
    expect(seen[0][0]).toBe('https://mine.test/catalog/');
    for (const builtIn of BRAND_CATALOG_URLS) expect(seen[0]).toContain(builtIn);
  });

  it('does not duplicate a mirror that is also a built-in', async () => {
    const builtIn = BRAND_CATALOG_URLS[0];
    const { ports } = syncHarness({ catalog: catalog([{ id: 'a' }], 1) });
    let urls: string[] = [];
    ports.fetchCatalog = async (options) => {
      urls = [...options.baseUrls];
      return { catalog: catalog([{ id: 'a' }], 1), baseUrl: builtIn, attempts: [] };
    };
    await syncBrandCatalog({ ports, extraBaseUrls: [builtIn] });
    expect(urls.filter((entry) => entry === builtIn)).toHaveLength(1);
  });
});
