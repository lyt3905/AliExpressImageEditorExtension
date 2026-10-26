import { describe, expect, it } from 'vitest';
import {
  bindMaterialRoles,
  pickSecondary,
  type BindCandidate,
} from '../../src/services/composition/bind-materials';

function candidate(id: string, width: number, height: number, label?: string): BindCandidate {
  return { materialId: id, width, height, label };
}

describe('bindMaterialRoles', () => {
  it('handles no material at all', () => {
    expect(bindMaterialRoles([])).toEqual({ heroId: null, boxId: null, reason: '没有可用素材' });
  });

  it('treats a lone material as the hero', () => {
    // Refusing because "no package found" would make single-photo products
    // uncomposable, which is half the catalogue.
    const result = bindMaterialRoles([candidate('a', 800, 1000, '商品正面图')]);
    expect(result.heroId).toBe('a');
    expect(result.boxId).toBeNull();
  });

  it('recognises a package by its label', () => {
    const result = bindMaterialRoles([
      candidate('front', 900, 1200, '商品正面图'),
      candidate('pkg', 800, 800, '包装图'),
    ]);
    expect(result.boxId).toBe('pkg');
    expect(result.heroId).toBe('front');
    expect(result.reason).toContain('包装');
  });

  it('does not let the package win the hero slot even when it is bigger', () => {
    const result = bindMaterialRoles([
      candidate('front', 400, 400, '商品正面图'),
      candidate('pkg', 1600, 1600, '礼盒'),
    ]);
    expect(result.boxId).toBe('pkg');
    expect(result.heroId).toBe('front');
  });

  it('falls back to the largest crop when nothing looks like packaging', () => {
    const result = bindMaterialRoles([
      candidate('small', 300, 400, '细节图'),
      candidate('big', 900, 1200, '商品正面图'),
    ]);
    expect(result.heroId).toBe('big');
    expect(result.boxId).toBeNull();
    expect(result.reason).toContain('没有包装盒');
  });
});

describe('pickSecondary', () => {
  const pool = [candidate('a', 400, 400), candidate('b', 900, 900), candidate('c', 600, 600)];

  it('picks the largest material that is not already used', () => {
    expect(pickSecondary(pool, ['b'])?.materialId).toBe('c');
  });

  it('ignores null and undefined ids in the used list', () => {
    expect(pickSecondary(pool, [null, undefined, 'a'])?.materialId).toBe('b');
  });

  it('returns null when everything is used', () => {
    expect(pickSecondary(pool, ['a', 'b', 'c'])).toBeNull();
  });

  it('returns null for an empty pool', () => {
    expect(pickSecondary([], [])).toBeNull();
  });
});
