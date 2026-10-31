import { describe, expect, it } from 'vitest';
import {
  brandSlug,
  buildCatalogBundle,
  imageExtension,
  sha256Hex,
} from '../../src/services/brand-catalog/export-bundle';
import { parseBrandCatalog } from '../../src/services/brand-catalog/schema';
import { listZipEntries } from '../../src/services/zip';
import { BRAND_CATALOG_LOGO_PATTERN } from '../../src/shared/constants';
import type { BrandMeta } from '../../src/shared/types';

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_MAGIC = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

function brand(overrides: Partial<BrandMeta> & { id: string; name: string }): BrandMeta {
  return {
    keywords: [],
    logoBlobId: overrides.id,
    width: 480,
    height: 180,
    createdAt: 1,
    ...overrides,
  };
}

function logoOf(bytes: Uint8Array): Blob {
  return new Blob([bytes as BlobPart], { type: 'image/png' });
}

const NOW = new Date('2026-10-31T09:30:00Z');

function fixedNow(): Date {
  return NOW;
}

describe('imageExtension', () => {
  it('sniffs png / jpg / webp from magic bytes', () => {
    expect(imageExtension(PNG_MAGIC)).toBe('png');
    expect(imageExtension(JPG_MAGIC)).toBe('jpg');
    expect(imageExtension(WEBP_MAGIC)).toBe('webp');
  });

  it('returns null for anything else', () => {
    expect(imageExtension(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(imageExtension(new Uint8Array([]))).toBeNull();
  });
});

describe('brandSlug', () => {
  it('keeps an ASCII name and lowercases it', () => {
    expect(brandSlug('Morph Toys Store', 'brand-x')).toBe('morph-toys-store');
  });

  it('falls back to a seed-derived id when the name has no ASCII left', () => {
    // 纯中文名不会留下任何可用字符；回落到 id 的尾段，而不是 brand-1（否则加一个
    // 品牌就会让前面的序号整体位移，等于把已有品牌重新命名一遍）。
    const first = brandSlug('银河玩具社', 'brand-m9x2k1-abc123');
    const second = brandSlug('另一个中文名', 'brand-m9x2k1-def456');
    expect(first).toBe('brand-abc123');
    expect(second).toBe('brand-def456');
  });

  it('always produces something matching the catalog slug pattern', () => {
    for (const [name, seed] of [
      ['银河玩具社', 'brand-!!'],
      ['', 'brand-x'],
      ['---', 'brand-y'],
      ['A'.repeat(200), 'brand-z'],
    ] as const) {
      expect(brandSlug(name, seed)).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
    }
  });
});

describe('buildCatalogBundle', () => {
  async function build(brands: BrandMeta[]) {
    return buildCatalogBundle(brands, {
      loadLogo: async (meta) => (meta.id.startsWith('gone') ? null : logoOf(PNG_MAGIC)),
      now: fixedNow(),
    });
  }

  it('writes a manifest the real parser accepts', async () => {
    const bundle = await build([
      brand({ id: 'remote-1', name: 'Morph Toys', keywords: ['Morph', 'MTS'], source: 'remote', slug: 'morph-toys' }),
      brand({ id: 'brand-abc', name: '银河玩具社', keywords: ['银河社'] }),
    ]);

    // 真正的验收标准：同步端读得进去。
    const catalog = parseBrandCatalog(bundle.manifest);
    expect(catalog.brands.map((entry) => entry.id)).toEqual(['brand-abc', 'morph-toys']);
    expect(catalog.brands.map((entry) => entry.name)).toEqual(['银河玩具社', 'Morph Toys']);
  });

  it('keeps the remote slug and derives one for hand-uploaded brands', async () => {
    const bundle = await build([
      brand({ id: 'remote-1', name: 'Morph Toys', source: 'remote', slug: 'morph-toys' }),
      brand({ id: 'brand-abc', name: 'PureSun Toys' }),
    ]);

    expect(bundle.brands.map((entry) => entry.id).sort()).toEqual(['morph-toys', 'puresun-toys']);
    for (const entry of bundle.brands) {
      expect(entry.file).toMatch(BRAND_CATALOG_LOGO_PATTERN);
    }
  });

  it('de-duplicates colliding slugs instead of overwriting a logo', async () => {
    const bundle = await build([
      brand({ id: 'brand-a', name: 'Galaxy Toys' }),
      brand({ id: 'brand-b', name: 'Galaxy-Toys' }),
    ]);

    expect(bundle.brands.map((entry) => entry.id).sort()).toEqual(['galaxy-toys', 'galaxy-toys-2']);
    expect(new Set(bundle.brands.map((entry) => entry.file)).size).toBe(2);
  });

  it('skips brands whose logo is missing and reports them', async () => {
    const bundle = await build([
      brand({ id: 'brand-ok', name: 'Ok Brand' }),
      brand({ id: 'gone-1', name: '丢失的 Logo' }),
    ]);

    expect(bundle.brands).toHaveLength(1);
    expect(bundle.skipped).toEqual(['丢失的 Logo']);
  });

  it('skips bytes that are not an image', async () => {
    const logos: Record<string, Blob> = {
      'brand-bad': logoOf(new Uint8Array([0x00, 0x01, 0x02])),
      'brand-ok': logoOf(PNG_MAGIC),
    };
    const bundle = await buildCatalogBundle(
      [brand({ id: 'brand-bad', name: 'Bad' }), brand({ id: 'brand-ok', name: 'Ok' })],
      {
        loadLogo: async (meta) => logos[meta.id] ?? null,
        now: fixedNow(),
      },
    );

    expect(bundle.brands.map((entry) => entry.name)).toEqual(['Ok']);
    expect(bundle.skipped).toEqual(['Bad']);
  });

  it('throws when nothing could be exported', async () => {
    await expect(
      buildCatalogBundle([brand({ id: 'gone-1', name: 'Gone' })], {
        loadLogo: async () => null,
        now: fixedNow(),
      }),
    ).rejects.toThrow(/没有任何品牌可以导出/);
  });

  it('fills sha256 so a logo swap re-downloads without bumping version', async () => {
    const bundle = await build([brand({ id: 'brand-a', name: 'A' })]);
    const catalog = parseBrandCatalog(bundle.manifest);

    expect(catalog.brands[0]?.logo.sha256).toBe(await sha256Hex(PNG_MAGIC));
    expect(catalog.brands[0]?.rev).toBe(await sha256Hex(PNG_MAGIC));
  });

  it('packs brands.json plus one logo per brand', async () => {
    const bundle = await build([
      brand({ id: 'brand-a', name: 'A' }),
      brand({ id: 'brand-b', name: 'B' }),
    ]);
    const archive = new Uint8Array(await bundle.blob.arrayBuffer());
    const entries = listZipEntries(archive);

    expect(entries.map((entry) => entry.path)).toEqual([
      'brands.json',
      'logos/a.png',
      'logos/b.png',
    ]);
  });

  it('defaults the version to epoch seconds and honours an explicit one', async () => {
    const auto = await build([brand({ id: 'brand-a', name: 'A' })]);
    expect(parseBrandCatalog(auto.manifest).version).toBe(Math.floor(NOW.getTime() / 1000));

    const explicit = await buildCatalogBundle([brand({ id: 'brand-a', name: 'A' })], {
      loadLogo: async () => logoOf(PNG_MAGIC),
      version: 42,
      now: fixedNow(),
    });
    expect(parseBrandCatalog(explicit.manifest).version).toBe(42);
  });

  it('names the file after the export date', async () => {
    const bundle = await build([brand({ id: 'brand-a', name: 'A' })]);
    expect(bundle.fileName).toBe('brand-catalog-2026-10-31.zip');
  });
});
