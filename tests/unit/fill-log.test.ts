import { afterEach, describe, expect, it } from 'vitest';

import { FILL_LOG_MAX, STORAGE_KEYS } from '../../src/shared/constants';
import {
  clearFillLog,
  fillLogKey,
  loadFillLog,
  mergeFillEntry,
  parseFillLog,
  recordFill,
  type FillLogEntry,
} from '../../src/services/fill-log';

/**
 * `chrome.storage.local` 的内存替身：只实现 `fill-log.ts` 用到的那三个调用，
 * 这样测的是"这张表怎么攒"，而不是浏览器本身。
 */
function stubStorage(seed: Record<string, unknown> = {}): Map<string, unknown> {
  const store = new Map<string, unknown>(Object.entries(seed));
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (store.has(key) ? { [key]: store.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) store.set(key, value);
        },
        remove: async (keys: string | string[]) => {
          for (const key of Array.isArray(keys) ? keys : [keys]) store.delete(key);
        },
      },
    },
  };
  return store;
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

const entry = (overrides: Partial<FillLogEntry> & { key: string; lastAt: number }): FillLogEntry => ({
  productCode: '',
  title: '',
  url: 'https://csp.aliexpress.com/x',
  firstAt: overrides.lastAt,
  count: 1,
  status: 'success',
  ...overrides,
});

describe('fillLogKey', () => {
  it('prefers the product code, which survives every entry point', () => {
    expect(fillLogKey({ productCode: ' 1005013435386786 ', url: 'https://a/edit' })).toBe(
      'code:1005013435386786',
    );
  });

  it('falls back to the whole url when the page carried no code', () => {
    expect(fillLogKey({ url: ' https://a/edit?productId=1 ' })).toBe('url:https://a/edit?productId=1');
    expect(fillLogKey({ productCode: '   ', url: 'https://a/edit' })).toBe('url:https://a/edit');
  });
});

describe('parseFillLog', () => {
  it('keeps valid rows newest first', () => {
    const log = parseFillLog([
      entry({ key: 'a', lastAt: 100 }),
      entry({ key: 'b', lastAt: 300 }),
      entry({ key: 'c', lastAt: 200 }),
    ]);
    expect(log.map((item) => item.key)).toEqual(['b', 'c', 'a']);
  });

  it('drops junk entries and anything that is not an array', () => {
    expect(parseFillLog(null)).toEqual([]);
    expect(parseFillLog('nope')).toEqual([]);
    expect(parseFillLog({})).toEqual([]);
    // 既没有键也没有地址的行既打不开也认不出。
    expect(parseFillLog([{ title: '只有标题' }, { key: 'k1', url: 'https://a' }])).toHaveLength(1);
  });

  it('derives a key when the stored one is missing, and fills defaults', () => {
    const [item] = parseFillLog([
      { productCode: ' 777 ', url: 'https://a/edit', lastAt: 0, count: 0, status: 'weird' },
    ]);
    expect(item.key).toBe('code:777');
    expect(item.count).toBe(1);
    expect(item.status).toBe('success');
    expect(item.firstAt).toBe(0);
  });

  it('dedupes by key, keeping the first hit', () => {
    const log = parseFillLog([
      entry({ key: 'a', lastAt: 200, title: '先' }),
      entry({ key: 'a', lastAt: 100, title: '后' }),
    ]);
    expect(log).toHaveLength(1);
    expect(log[0].title).toBe('先');
  });

  it(`caps the table at ${FILL_LOG_MAX} rows`, () => {
    const many = Array.from({ length: FILL_LOG_MAX + 5 }, (_, index) =>
      entry({ key: `k${index}`, lastAt: index + 1 }),
    );
    const log = parseFillLog(many);
    expect(log).toHaveLength(FILL_LOG_MAX);
    expect(log[0].key).toBe(`k${FILL_LOG_MAX + 4}`);
  });
});

describe('mergeFillEntry', () => {
  const base = { productCode: '100', title: '手办', url: 'https://a/edit', at: 1000 };

  it('adds a brand-new product at the front', () => {
    const log = mergeFillEntry([], { ...base, key: 'code:100', status: 'success' });
    expect(log).toEqual([
      {
        key: 'code:100',
        productCode: '100',
        title: '手办',
        url: 'https://a/edit',
        firstAt: 1000,
        lastAt: 1000,
        count: 1,
        status: 'success',
      },
    ]);
  });

  it('counts a repeat of the same product instead of writing a second row', () => {
    const first = mergeFillEntry([], { ...base, key: 'code:100', status: 'success' });
    const second = mergeFillEntry(first, { ...base, key: 'code:100', at: 2000, status: 'unconfirmed' });
    expect(second).toHaveLength(1);
    expect(second[0].count).toBe(2);
    expect(second[0].firstAt).toBe(1000);
    expect(second[0].lastAt).toBe(2000);
    expect(second[0].status).toBe('unconfirmed');
  });

  it('keeps the stored title when a later run arrives without one', () => {
    const first = mergeFillEntry([], { ...base, key: 'code:100', status: 'success' });
    const second = mergeFillEntry(first, { ...base, title: '', at: 2000, key: 'code:100', status: 'success' });
    expect(second[0].title).toBe('手办');
  });

  it('fills a title that was missing at first', () => {
    const first = mergeFillEntry([], { ...base, title: '', key: 'code:100', status: 'success' });
    const second = mergeFillEntry(first, { ...base, at: 2000, key: 'code:100', status: 'success' });
    expect(second[0].title).toBe('手办');
  });

  it('re-sorts by last activity and caps the table', () => {
    let log: FillLogEntry[] = [];
    for (let index = 0; index < FILL_LOG_MAX + 3; index += 1) {
      log = mergeFillEntry(log, {
        key: `k${index}`,
        productCode: '',
        title: '',
        url: `https://a/${index}`,
        at: index + 1,
        status: 'success',
      });
    }
    expect(log).toHaveLength(FILL_LOG_MAX);
    expect(log[0].key).toBe(`k${FILL_LOG_MAX + 2}`);
    // 最老的那几条被挤掉了。
    expect(log.some((item) => item.key === 'k0')).toBe(false);
  });
});

describe('recordFill / loadFillLog / clearFillLog', () => {
  it('writes into storage and reads back, counting repeats', async () => {
    stubStorage();
    await recordFill({ productCode: '100', title: '手办', url: 'https://a/edit', status: 'success', at: 1000 });
    const log = await recordFill({
      productCode: '100',
      title: '手办',
      url: 'https://a/edit',
      status: 'success',
      at: 2000,
    });
    expect(log).toHaveLength(1);
    expect(log[0].count).toBe(2);
    expect(await loadFillLog()).toEqual(log);
  });

  it('stores the table under the fill-log key', async () => {
    const store = stubStorage();
    await recordFill({ url: 'https://a/edit', status: 'unconfirmed', at: 500 });
    const stored = store.get(STORAGE_KEYS.fillLog) as FillLogEntry[];
    expect(stored).toHaveLength(1);
    expect(stored[0].key).toBe('url:https://a/edit');
    expect(stored[0].status).toBe('unconfirmed');
  });

  it('survives a corrupt stored value', async () => {
    stubStorage({ [STORAGE_KEYS.fillLog]: { broken: true } });
    expect(await loadFillLog()).toEqual([]);
    const log = await recordFill({ productCode: '1', url: 'https://a', status: 'success', at: 10 });
    expect(log).toHaveLength(1);
  });

  it('clears the table', async () => {
    const store = stubStorage();
    await recordFill({ productCode: '1', url: 'https://a', status: 'success', at: 10 });
    await clearFillLog();
    expect(store.has(STORAGE_KEYS.fillLog)).toBe(false);
    expect(await loadFillLog()).toEqual([]);
  });

  it('never throws when storage is broken', async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async () => {
            throw new Error('storage down');
          },
          set: async () => {
            throw new Error('storage down');
          },
          remove: async () => {
            throw new Error('storage down');
          },
        },
      },
    };
    await expect(recordFill({ productCode: '1', url: 'https://a', status: 'success', at: 10 })).resolves.toEqual([
      expect.objectContaining({ key: 'code:1', count: 1 }),
    ]);
    await expect(clearFillLog()).resolves.toBeUndefined();
    expect(await loadFillLog()).toEqual([]);
  });
});
