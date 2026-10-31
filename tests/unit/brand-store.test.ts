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
import {
  brandTerms,
  matchBrandByTitle,
  matchBrandByTitleDetailed,
  parseBrandTerms,
  termMatchesTitle,
} from '../../src/services/brand-store';

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

describe('matchBrandByTitleDetailed', () => {
  it('reports the keyword that matched, leaving the hit explicable', () => {
    const brands = [brand({ id: 'g', name: '银河玩具社', keywords: ['银河社', 'Galaxy Toys'] })];
    const match = matchBrandByTitleDetailed(brands, 'Galaxy Toys FM-04 Ratchet');
    expect(match?.brand.id).toBe('g');
    expect(match?.term).toBe('Galaxy Toys');
  });

  it('reports the original spelling, not the lower-cased one', () => {
    const brands = [brand({ id: 'm', name: '魔方', keywords: ['MS-TOYS'] })];
    expect(matchBrandByTitleDetailed(brands, 'transformation ms-toys robot')?.term).toBe('MS-TOYS');
  });

  it('exposes the keyword that stood alone — even a two-letter one', () => {
    // "FT" as a keyword is still a liability (any title with a bare FT claims it),
    // but at least it has to appear as its own word: `FT Ratchet` counts,
    // `FansToys` does not.
    const brands = [brand({ id: 'f', name: 'FansToys', keywords: ['FT'] })];
    const title = 'Hot Sale Transformation FansToys MP FM-04 FM04 FT Ratchet Doc Action Figure';
    expect(matchBrandByTitleDetailed(brands, title)?.term).toBe('FT');
  });

  it('returns null when nothing matches', () => {
    expect(matchBrandByTitleDetailed([brand({ id: 'a', keywords: ['银河社'] })], 'MP-44 Optimus')).toBeNull();
  });
});

/**
 * 10.21.1：拉丁字母关键词必须**整词出现**。
 *
 * 子串匹配把 `Fans` 认成 `FansHobby`、把 `Hasbro` 认成 `HasbroStudio` ——
 * 字母一样，品牌不一样。中文没有词边界，所以只含中文的关键词仍然是子串。
 */
describe('termMatchesTitle', () => {
  const fansHobbyTitle =
    'In Stock Transformation FansHobby MB-23A MB23A Fright Storm Devastator Third-Party Action Figures Collection Gifts';

  it('does not let a keyword match inside a longer word', () => {
    expect(termMatchesTitle(fansHobbyTitle, 'Fans')).toBe(false);
    expect(matchBrandByTitleDetailed([brand({ id: 'f', keywords: ['Fans'] })], fansHobbyTitle)).toBeNull();
  });

  it('still matches the keyword when it stands on its own', () => {
    expect(termMatchesTitle('FansToys FT-04 Scoria', 'FansToys')).toBe(true);
    expect(termMatchesTitle('Fans Toys FT-04 Scoria', 'Fans Toys')).toBe(true);
    expect(termMatchesTitle('Fans, FT-04 Scoria', 'Fans')).toBe(true);
    expect(termMatchesTitle('Fans-04 Scoria', 'Fans')).toBe(true);
  });

  it('keeps scanning after a glued hit', () => {
    expect(termMatchesTitle('FansHobby vs Fans Toys', 'Fans')).toBe(true);
  });

  it('keeps substring matching for Chinese keywords', () => {
    // 中文没有空格，也不会把两个字粘成一个词
    expect(termMatchesTitle('现货银河社变形玩具模型', '银河社')).toBe(true);
    expect(termMatchesTitle('变形金刚 孩之宝 正版', '孩之宝')).toBe(true);
  });

  it('treats Chinese text next to a Latin keyword as a boundary', () => {
    expect(termMatchesTitle('Hasbro变形金刚核心级', 'Hasbro')).toBe(true);
    expect(termMatchesTitle('HasbroStudio 出品', 'Hasbro')).toBe(false);
  });

  it('is not fooled by a longer latin word carrying the prefix', () => {
    expect(termMatchesTitle('threezeroes edition', 'threezero')).toBe(false);
    expect(termMatchesTitle('threezero 1/6 figure', 'threezero')).toBe(true);
  });

  it('ignores empty and blank keywords', () => {
    expect(termMatchesTitle('anything', '')).toBe(false);
    expect(termMatchesTitle('anything', '   ')).toBe(false);
    expect(termMatchesTitle('', 'Fans')).toBe(false);
  });
});
