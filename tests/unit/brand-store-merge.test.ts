import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '../../src/shared/constants';
import { getBlob, putBlob, clearAll, resetDatabaseCache } from '../../src/services/indexed-db';
import {
  listBrands,
  mergeRemoteBrands,
  saveBrand,
} from '../../src/services/brand-store';
import { remoteBrandId, remoteLogoBlobId } from '../../src/services/brand-catalog/schema';
import type { BrandMeta } from '../../src/shared/types';

/**
 * `mergeRemoteBrands` is the only writer a catalog sync uses, so these tests are
 * about the three promises that keep a sync from being destructive: local brands
 * survive, the seller's renames survive, and a removed brand keeps its blob.
 */

function installChromeStub(): void {
  const backing = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (backing.has(key) ? { [key]: backing.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) backing.set(key, value);
        },
      },
    },
  };
}

function pngBlob(): Blob {
  return new Blob([new Uint8Array(32)], { type: 'image/png' });
}

function upsert(slug: string, overrides: Partial<BrandMeta> = {}): BrandMeta {
  return {
    id: remoteBrandId(slug),
    name: slug,
    keywords: [],
    logoBlobId: remoteLogoBlobId(slug),
    width: 200,
    height: 100,
    createdAt: 2_000,
    source: 'remote',
    slug,
    remoteRev: 'rev-2',
    ...overrides,
  };
}

beforeAll(() => {
  // `saveBrand` measures the image; the stub decodes every blob as 200x100.
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => ({
    width: 200,
    height: 100,
    close: () => undefined,
  });
});

beforeEach(async () => {
  installChromeStub();
  resetDatabaseCache();
  await clearAll();
});

describe('mergeRemoteBrands', () => {
  it('adds catalog brands next to the hand-uploaded ones', async () => {
    await saveBrand({ file: pngBlob(), name: 'Hand Made' });
    const merged = await mergeRemoteBrands({ upserts: [upsert('morph-toys')], removeIds: [] });

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ name: 'Hand Made', source: 'local' });
    expect(merged[1]).toMatchObject({
      id: 'remote-morph-toys',
      source: 'remote',
      slug: 'morph-toys',
      remoteRev: 'rev-2',
    });
  });

  it('refreshes an existing brand in place and keeps its createdAt', async () => {
    await mergeRemoteBrands({
      upserts: [upsert('morph-toys', { createdAt: 1_000, name: 'Old Name', remoteRev: 'rev-1' })],
      removeIds: [],
    });
    const merged = await mergeRemoteBrands({
      upserts: [upsert('morph-toys', { createdAt: 9_999, name: 'New Name' })],
      removeIds: [],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      name: 'New Name',
      remoteRev: 'rev-2',
      // Order in the Options page is "oldest first"; a daily sync must not push
      // every brand to the bottom.
      createdAt: 1_000,
    });
  });

  it('lets a renamed catalog brand keep the seller wording', async () => {
    await mergeRemoteBrands({ upserts: [upsert('morph-toys', { name: 'Morph Toys' })], removeIds: [] });
    // `updateBrand` sets `edited` when the seller touches a remote brand.
    const edited = (await listBrands()).map((entry) => ({
      ...entry,
      name: '摩变玩具',
      keywords: ['摩变'],
      edited: true,
    }));
    await (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set({
      [STORAGE_KEYS.brands]: edited,
    });

    const merged = await mergeRemoteBrands({
      upserts: [upsert('morph-toys', { name: 'Morph Toys', keywords: ['MT'], remoteRev: 'rev-3' })],
      removeIds: [],
    });
    expect(merged[0]).toMatchObject({
      name: '摩变玩具',
      keywords: ['摩变'],
      // The logo still refreshes — only the wording is protected.
      remoteRev: 'rev-3',
      edited: true,
    });
  });

  it('drops the registry row but keeps the blob when a brand leaves the catalog', async () => {
    await mergeRemoteBrands({ upserts: [upsert('gone')], removeIds: [] });
    // Pretend the sync had stored the logo bytes for it.
    await putBlob(remoteLogoBlobId('gone'), pngBlob());
    expect(await getBlob(remoteLogoBlobId('gone'))).not.toBeNull();

    const merged = await mergeRemoteBrands({ upserts: [], removeIds: [remoteBrandId('gone')] });
    expect(merged).toEqual([]);
    // A saved composition may still hold a logo layer pointing at this blob, so
    // the bytes stay even though the brand is no longer offered.
    expect(await getBlob(remoteLogoBlobId('gone'))).not.toBeNull();
  });

  it('never removes a local brand even if its id is in removeIds', async () => {
    const local = await saveBrand({ file: pngBlob(), name: 'Hand Made' });
    const merged = await mergeRemoteBrands({ upserts: [], removeIds: [local.id] });
    expect(merged.map((entry) => entry.id)).toEqual([local.id]);
  });
});

describe('legacy aliases', () => {
  /**
   * 10.9.x stored every brand with an extra `aliases` list, and both the name and
   * the aliases counted as title keywords. 10.10.0 keeps `name` + `keywords`
   * only, so the aliases of an already-installed brand have to survive as
   * keywords — losing them would silently stop detecting those brands.
   */
  function legacyBrand(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      name: '魔方',
      keywords: [],
      logoBlobId: 'blob-legacy',
      width: 200,
      height: 100,
      createdAt: 1,
      ...overrides,
    };
  }

  it('folds a stored aliases list into keywords', async () => {
    await (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set({
      [STORAGE_KEYS.brands]: [legacyBrand({ id: 'legacy-1', aliases: ['MS-TOYS', 'Magic Square'] })],
    });

    const [entry] = await listBrands();
    expect(entry.keywords).toEqual(['MS-TOYS', 'Magic Square']);
    // The dead field must not be handed around any more — a caller writing the
    // list back would otherwise keep resurrecting it in storage.
    expect(entry).not.toHaveProperty('aliases');
  });

  it('appends legacy aliases after keywords and skips duplicates', async () => {
    await (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set({
      [STORAGE_KEYS.brands]: [
        legacyBrand({ id: 'legacy-2', keywords: ['魔方', 'MS-TOYS'], aliases: ['MS-TOYS', 'Magic Square'] }),
      ],
    });

    const [entry] = await listBrands();
    expect(entry.keywords).toEqual(['魔方', 'MS-TOYS', 'Magic Square']);
  });

  it('tolerates junk in either field', async () => {
    await (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set({
      [STORAGE_KEYS.brands]: [
        legacyBrand({ id: 'legacy-3', keywords: 'nope', aliases: [42, 'Magic Square', '  '] }),
      ],
    });

    const [entry] = await listBrands();
    expect(entry.keywords).toEqual(['Magic Square']);
  });
});
