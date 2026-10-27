import { describe, expect, it } from 'vitest';
import {
  BRAND_CATALOG_MAX_BRANDS,
  BRAND_CATALOG_MAX_BYTES,
} from '../../src/shared/constants';
import {
  CatalogError,
  parseBrandCatalog,
  remoteBrandId,
  remoteLogoBlobId,
  resolveCatalogUrl,
  resolveLogoUrl,
} from '../../src/services/brand-catalog/schema';

/**
 * The catalog is remote input that ends up in IndexedDB, so these tests are the
 * gate: shape, sizes, and above all "can a manifest make us fetch something else".
 */

function manifest(brands: unknown[], version = 1): string {
  return JSON.stringify({ version, brands });
}

function brand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'morph-toys',
    name: 'Morph Toys Store',
    aliases: ['Morph Toys'],
    keywords: ['morph'],
    logo: { file: 'logos/morph-toys.png' },
    ...overrides,
  };
}

function expectCatalogError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CatalogError);
    expect((error as CatalogError).code).toBe(code);
    return;
  }
  throw new Error('expected CatalogError');
}

describe('parseBrandCatalog', () => {
  it('normalises a minimal brand and defaults the term lists', () => {
    const catalog = parseBrandCatalog(manifest([{ id: 'x', name: 'X', logo: { file: 'logos/x.png' } }]));
    expect(catalog.version).toBe(1);
    expect(catalog.brands).toEqual([
      {
        id: 'x',
        name: 'X',
        aliases: [],
        keywords: [],
        logo: { file: 'logos/x.png' },
        // No sha256 and no rev → the version is the fingerprint, so bumping
        // `version` alone is enough to refresh everything.
        rev: 'v1',
      },
    ]);
  });

  it('falls back to sha256 for rev, and to an explicit rev before that', () => {
    const sha = 'a'.repeat(64);
    const fromSha = parseBrandCatalog(
      manifest([brand({ logo: { file: 'logos/morph-toys.png', sha256: sha.toUpperCase() } })], 3),
    );
    expect(fromSha.brands[0].logo.sha256).toBe(sha);
    expect(fromSha.brands[0].rev).toBe(sha);

    const explicit = parseBrandCatalog(
      manifest([brand({ logo: { file: 'logos/morph-toys.png', sha256: sha }, rev: '2026-10-27' })]),
    );
    expect(explicit.brands[0].rev).toBe('2026-10-27');
  });

  it('trims and de-duplicates terms', () => {
    const catalog = parseBrandCatalog(
      manifest([brand({ aliases: [' MT ', 'MT', 'MorphToys', '  '] })]),
    );
    expect(catalog.brands[0].aliases).toEqual(['MT', 'MorphToys']);
  });

  it('rejects a version that is not a positive integer', () => {
    for (const version of [0, 1.5, '2']) {
      expectCatalogError(() => parseBrandCatalog(manifest([brand()], version as number)), 'shape');
    }
    // Missing entirely — the default argument of `manifest` would hide this case.
    expectCatalogError(() => parseBrandCatalog(JSON.stringify({ brands: [brand()] })), 'shape');
  });

  it('rejects malformed bodies', () => {
    expectCatalogError(() => parseBrandCatalog(''), 'shape');
    expectCatalogError(() => parseBrandCatalog('not json'), 'shape');
    expectCatalogError(() => parseBrandCatalog('[]'), 'shape');
    expectCatalogError(() => parseBrandCatalog('{"version":1}'), 'shape');
  });

  it('rejects bad slugs, empty names and duplicate ids', () => {
    expectCatalogError(() => parseBrandCatalog(manifest([brand({ id: 'Morph_Toys' })])), 'shape');
    expectCatalogError(() => parseBrandCatalog(manifest([brand({ id: '' })])), 'shape');
    expectCatalogError(() => parseBrandCatalog(manifest([brand({ name: '   ' })])), 'shape');
    expectCatalogError(
      () => parseBrandCatalog(manifest([brand(), brand({ name: 'Same id' })])),
      'duplicate',
    );
  });

  it('refuses logo paths that are not a relative logos/<name>.<ext>', () => {
    for (const file of [
      'https://evil.test/x.png',
      '/etc/passwd.png',
      'logos/../x.png',
      'logos/sub/x.png',
      'logos/x.gif',
      'logos/X.PNG',
      'x.png',
    ]) {
      expectCatalogError(
        () => parseBrandCatalog(manifest([brand({ logo: { file } })])),
        'shape',
      );
    }
  });

  it('caps the number of brands and the byte size', () => {
    const many = Array.from({ length: BRAND_CATALOG_MAX_BRANDS + 1 }, (_, index) =>
      brand({ id: `brand-${index}`, logo: { file: `logos/brand-${index}.png` } }),
    );
    expectCatalogError(() => parseBrandCatalog(manifest(many)), 'count');

    // One brand, one absurdly long term: the byte ceiling fires before parsing.
    const oversized = `{"version":1,"brands":[],"padding":"${'x'.repeat(BRAND_CATALOG_MAX_BYTES)}"}`;
    expectCatalogError(() => parseBrandCatalog(oversized), 'size');
  });

  it('caps per-term length and term count', () => {
    expectCatalogError(
      () => parseBrandCatalog(manifest([brand({ keywords: ['k'.repeat(61)] })])),
      'shape',
    );
    const tooMany = Array.from({ length: 41 }, (_, index) => `k${index}`);
    expectCatalogError(() => parseBrandCatalog(manifest([brand({ keywords: tooMany })])), 'shape');
  });
});

describe('resolveCatalogUrl / resolveLogoUrl', () => {
  const base = 'https://raw.githubusercontent.com/lyt3905/AliExpressImageEditorExtension/main/catalog/';

  it('resolves the manifest and normalises a missing trailing slash', () => {
    expect(resolveCatalogUrl(base)).toBe(`${base}brands.json`);
    expect(resolveCatalogUrl(base.replace(/\/$/, ''))).toBe(`${base}brands.json`);
  });

  it('only accepts https (loopback may use http for local testing)', () => {
    expectCatalogError(() => resolveCatalogUrl('http://example.com/catalog/'), 'url');
    expectCatalogError(() => resolveCatalogUrl('ftp://example.com/catalog/'), 'url');
    expectCatalogError(() => resolveCatalogUrl('not a url'), 'url');
    expect(resolveCatalogUrl('http://127.0.0.1:8080/catalog/')).toBe(
      'http://127.0.0.1:8080/catalog/brands.json',
    );
    expect(resolveCatalogUrl('http://localhost:8080/catalog/')).toBe(
      'http://localhost:8080/catalog/brands.json',
    );
  });

  it('resolves a logo inside the catalog directory', () => {
    expect(resolveLogoUrl(base, 'logos/morph-toys.png')).toBe(`${base}logos/morph-toys.png`);
  });

  it('refuses a logo path that would leave the directory', () => {
    // The regex already rejects `..`, but the parsed-URL check is the belt to its
    // braces: it is what keeps a future loosening of the regex from escaping.
    expectCatalogError(() => resolveLogoUrl(base, 'logos/../secret.png'), 'url');
    expectCatalogError(() => resolveLogoUrl(base, 'https://evil.test/logo.png'), 'url');
  });
});

describe('remote ids', () => {
  it('derives both ids from the slug, so a re-sync keeps the same blob id', () => {
    expect(remoteBrandId('morph-toys')).toBe('remote-morph-toys');
    expect(remoteLogoBlobId('morph-toys')).toBe('brand-logo-remote-morph-toys');
  });
});
