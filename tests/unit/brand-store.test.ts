/**
 * Brand registry logic: keyword parsing and title matching.
 *
 * Pure functions over plain data, so the tests run in the node environment
 * without touching chrome.storage or IndexedDB.
 *
 * The rule these tests pin down: **only `keywords` match a title.** The display
 * name tells brands apart. A brand called「魔方」must not be claimed because a
 * title happens to contain those two characters.
 */

import { describe, expect, it } from 'vitest';
import type { BrandMeta } from '../../src/shared/types';
import { brandTerms, matchBrandByTitle, parseBrandTerms } from '../../src/services/brand-store';

function brand(partial: Partial<BrandMeta> & { id: string }): BrandMeta {
  return {
    name: 'Brand',
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
  it('is the keyword list, not the display name', () => {
    expect(brandTerms(brand({ id: 'b', name: 'Hasbro', keywords: ['孩之宝', 'Transformers'] }))).toEqual([
      '孩之宝',
      'Transformers',
    ]);
  });
});

describe('matchBrandByTitle', () => {
  const brands = [
    brand({ id: 'a', name: 'Morph Toys', keywords: ['Morph Toys', 'MT', 'Transformation Galaxy'] }),
    brand({ id: 'b', name: 'PureSun', keywords: ['PS', 'Sunny'] }),
  ];

  it('matches a keyword case-insensitively', () => {
    expect(matchBrandByTitle(brands, 'collector mt edition')?.id).toBe('a');
  });

  it('matches a multi-word keyword', () => {
    expect(matchBrandByTitle(brands, 'Transformation Galaxy OP Commander')?.id).toBe('a');
  });

  it('ignores the display name entirely', () => {
    // "PureSun" is the brand's name only; its keywords are PS / Sunny.
    expect(matchBrandByTitle(brands, 'PureSun robot figure')).toBeNull();
  });

  it('returns null when nothing matches', () => {
    expect(matchBrandByTitle(brands, 'Some other toy brand')).toBeNull();
  });

  it('returns null for a brand with no keywords at all', () => {
    expect(matchBrandByTitle([brand({ id: 'z', name: '官方马赛克' })], '官方马赛克 灯片')).toBeNull();
  });

  it('returns the first brand in registry order on overlap', () => {
    const overlapping = [
      brand({ id: 'x', name: 'Galaxy', keywords: ['Galaxy'] }),
      brand({ id: 'y', name: 'Galaxy Toys', keywords: ['Galaxy Toys'] }),
    ];
    expect(matchBrandByTitle(overlapping, 'Galaxy Toys')?.id).toBe('x');
  });
});
