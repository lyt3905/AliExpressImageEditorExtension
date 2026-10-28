import { describe, expect, it } from 'vitest';
import { isAllowedCatalogBase, resolveCatalogUrl } from '../../src/services/brand-catalog/schema';

/**
 * The self-hosted mirror field lets the seller type an arbitrary URL, and that URL
 * is what the extension will fetch. `isAllowedCatalogBase` is the gate the Options
 * page uses to refuse a bad value before saving — it must agree with the resolver,
 * or the page would happily save something every future sync then rejects.
 */
describe('isAllowedCatalogBase', () => {
  it('accepts https catalog directories', () => {
    expect(isAllowedCatalogBase('https://cdn.example.com/catalog/')).toBe(true);
    expect(isAllowedCatalogBase('https://cdn.example.com/catalog')).toBe(true);
  });

  it('accepts loopback over http (local catalog hosting)', () => {
    expect(isAllowedCatalogBase('http://127.0.0.1:8080/catalog/')).toBe(true);
    expect(isAllowedCatalogBase('http://localhost/catalog/')).toBe(true);
  });

  it('refuses plain http on a public host', () => {
    expect(isAllowedCatalogBase('http://cdn.example.com/catalog/')).toBe(false);
  });

  it('refuses non-http protocols and garbage', () => {
    expect(isAllowedCatalogBase('ftp://cdn.example.com/catalog/')).toBe(false);
    expect(isAllowedCatalogBase('not a url')).toBe(false);
    expect(isAllowedCatalogBase('')).toBe(false);
  });

  it('agrees with resolveCatalogUrl on what it accepts', () => {
    const good = 'https://cdn.example.com/catalog/';
    expect(isAllowedCatalogBase(good)).toBe(true);
    expect(resolveCatalogUrl(good)).toBe('https://cdn.example.com/catalog/brands.json');
  });
});
