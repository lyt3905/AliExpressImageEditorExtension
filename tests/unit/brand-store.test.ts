/**
 * Brand registry logic: alias/keyword parsing and title matching.
 *
 * Pure functions over plain data, so the tests run in the node environment
 * without touching chrome.storage or IndexedDB.
 */

import { describe, expect, it } from 'vitest';
import type { BrandMeta } from '../../src/shared/types';
import { brandTerms, matchBrandByTitle, parseBrandTerms } from '../../src/services/brand-store';

function brand(partial: Partial<BrandMeta> & { id: string }): BrandMeta {
  return {
    name: 'Brand',
    aliases: [],
    keywords: [],
    logoBlobId: 'blob',
    width: 100,
    height: 100,
    createdAt: 0,
    ...partial,
  };
}

describe('parseBrandTerms', () => {
  it('splits on commas, spaces, and Chinese separators', () => {
    expect(parseBrandTerms('MT, MorphToys、摩变；MT 二次元')).toEqual([
      'MT',
      'MorphToys',
      '摩变',
      '二次元',
    ]);
  });

  it('drops empty entries and duplicates', () => {
    expect(parseBrandTerms('  A ,, A ; B  ')).toEqual(['A', 'B']);
  });
});

describe('brandTerms', () => {
  it('combines name, aliases and keywords', () => {
    expect(
      brandTerms(brand({ id: 'b', name: 'Hasbro', aliases: ['孩之宝'], keywords: ['Transformers'] })),
    ).toEqual(['Hasbro', '孩之宝', 'Transformers']);
  });
});

describe('matchBrandByTitle', () => {
  const brands = [
    brand({ id: 'a', name: 'Morph Toys', aliases: ['MT'], keywords: ['Transformation Galaxy'] }),
    brand({ id: 'b', name: 'PureSun', aliases: ['PS'], keywords: ['Sunny'] }),
  ];

  it('matches the brand name', () => {
    expect(matchBrandByTitle(brands, 'Morph Toys robot figure')?.id).toBe('a');
  });

  it('matches an alias case-insensitively', () => {
    expect(matchBrandByTitle(brands, 'collector MT edition')?.id).toBe('a');
  });

  it('matches a keyword', () => {
    expect(matchBrandByTitle(brands, 'Transformation Galaxy OP Commander')?.id).toBe('a');
  });

  it('returns null when nothing matches', () => {
    expect(matchBrandByTitle(brands, 'Some other toy brand')).toBeNull();
  });

  it('returns the first brand in registry order on overlap', () => {
    const overlapping = [
      brand({ id: 'x', name: 'Galaxy' }),
      brand({ id: 'y', name: 'Galaxy Toys' }),
    ];
    expect(matchBrandByTitle(overlapping, 'Galaxy Toys')?.id).toBe('x');
  });
});
