import { afterEach, describe, expect, it } from 'vitest';

import { ERROR_LOG_MAX, STORAGE_KEYS } from '../../src/shared/constants';
import {
  appendError,
  clearErrorLog,
  loadErrorLog,
  mergeErrorEntry,
  parseErrorLog,
} from '../../src/services/error-log';

/**
 * `chrome.storage.local` 的内存替身：只实现被 `error-log.ts` 用到的那三个调用，
 * 这样测的是"记录怎么攒"，而不是浏览器本身。
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

describe('parseErrorLog', () => {
  it('keeps valid rows, newest first', () => {
    const log = parseErrorLog([
      { code: 'A', message: '早', at: 100 },
      { code: 'B', message: '晚', at: 300 },
      { code: 'C', message: '中', at: 200 },
    ]);
    expect(log.map((entry) => entry.code)).toEqual(['B', 'C', 'A']);
    expect(log[0]).toEqual({ code: 'B', message: '晚', at: 300, count: 1 });
  });

  it('drops rows without a message and anything that is not an object', () => {
    const log = parseErrorLog([
      null,
      42,
      'text',
      { code: 'A' },
      { code: 'B', message: '   ' },
      { code: 'C', message: '留' },
    ]);
    expect(log).toHaveLength(1);
    expect(log[0].message).toBe('留');
  });

  it('falls back to E_UNKNOWN and count 1 for half-filled rows', () => {
    const log = parseErrorLog([{ message: '没写 code', at: 5 }]);
    expect(log[0]).toMatchObject({ code: 'E_UNKNOWN', count: 1 });
  });

  it('never reports a count below one', () => {
    const log = parseErrorLog([{ code: 'A', message: 'x', at: 1, count: -3 }]);
    expect(log[0].count).toBeGreaterThanOrEqual(1);
  });

  it('caps the log at ERROR_LOG_MAX rows', () => {
    const raw = Array.from({ length: ERROR_LOG_MAX + 7 }, (_, index) => ({
      code: 'A',
      message: `m${index}`,
      at: index + 1,
    }));
    expect(parseErrorLog(raw)).toHaveLength(ERROR_LOG_MAX);
  });

  it('returns an empty log for anything that is not an array', () => {
    for (const value of [null, undefined, 0, 'x', {}, { 0: 'a' }]) {
      expect(parseErrorLog(value)).toEqual([]);
    }
  });
});

describe('mergeErrorEntry', () => {
  it('starts a new row with count 1', () => {
    const log = mergeErrorEntry([], { code: 'E_UNSUPPORTED_PAGE', message: '不是商品页', at: 10 });
    expect(log).toEqual([{ code: 'E_UNSUPPORTED_PAGE', message: '不是商品页', at: 10, count: 1 }]);
  });

  it('counts a repeated identical failure on the newest row', () => {
    const first = mergeErrorEntry([], { code: 'A', message: '同一个', at: 10 });
    const second = mergeErrorEntry(first, { code: 'A', message: '同一个', at: 20 });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ count: 2, at: 20 });
  });

  it('does not merge across another error in between', () => {
    const a = mergeErrorEntry([], { code: 'A', message: '甲', at: 10 });
    const b = mergeErrorEntry(a, { code: 'B', message: '乙', at: 20 });
    const again = mergeErrorEntry(b, { code: 'A', message: '甲', at: 30 });
    expect(again.map((entry) => entry.code)).toEqual(['A', 'B', 'A']);
    expect(again[0].count).toBe(1);
  });

  it('treats same code with different message as a different row', () => {
    const first = mergeErrorEntry([], { code: 'A', message: '一', at: 10 });
    const second = mergeErrorEntry(first, { code: 'A', message: '二', at: 20 });
    expect(second).toHaveLength(2);
  });

  it('keeps the log capped when a new row arrives on a full log', () => {
    let log = Array.from({ length: ERROR_LOG_MAX }, (_, index) => ({
      code: 'A',
      message: `m${index}`,
      at: index + 1,
      count: 1,
    }));
    log = mergeErrorEntry(log, { code: 'NEW', message: '新的', at: 999 });
    expect(log).toHaveLength(ERROR_LOG_MAX);
    expect(log[0].code).toBe('NEW');
  });
});

describe('appendError / loadErrorLog / clearErrorLog', () => {
  it('writes the log and keeps the legacy last-error key in sync', async () => {
    const store = stubStorage();
    await appendError({ code: 'E_UNSUPPORTED_PAGE', message: '不是商品页', at: 1000 });

    const log = store.get(STORAGE_KEYS.errorLog) as Array<{ count: number }>;
    expect(log).toHaveLength(1);
    expect(log[0].count).toBe(1);
    // 老版本读的是这个键；多写一份不值得为它留一条兼容分支。
    expect(store.get(STORAGE_KEYS.lastError)).toMatchObject({ code: 'E_UNSUPPORTED_PAGE', at: 1000 });
  });

  it('accumulates across calls instead of overwriting', async () => {
    stubStorage();
    await appendError({ code: 'A', message: '甲', at: 10 });
    await appendError({ code: 'A', message: '甲', at: 20 });
    await appendError({ code: 'B', message: '乙', at: 30 });

    const log = await loadErrorLog();
    expect(log.map((entry) => entry.code)).toEqual(['B', 'A']);
    expect(log[1].count).toBe(2);
  });

  it('returns an empty log when nothing was ever recorded', async () => {
    stubStorage();
    expect(await loadErrorLog()).toEqual([]);
  });

  it('survives a corrupt stored value', async () => {
    stubStorage({ [STORAGE_KEYS.errorLog]: 'not an array' });
    expect(await loadErrorLog()).toEqual([]);
  });

  it('appends onto a corrupt log without throwing', async () => {
    stubStorage({ [STORAGE_KEYS.errorLog]: 42 });
    await appendError({ code: 'A', message: '甲', at: 10 });
    const log = await loadErrorLog();
    expect(log.map((entry) => entry.code)).toEqual(['A']);
  });

  it('clears both keys', async () => {
    const store = stubStorage();
    await appendError({ code: 'A', message: '甲', at: 10 });
    await clearErrorLog();
    expect(store.has(STORAGE_KEYS.errorLog)).toBe(false);
    expect(store.has(STORAGE_KEYS.lastError)).toBe(false);
    expect(await loadErrorLog()).toEqual([]);
  });

  it('does not throw when storage itself throws', async () => {
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async () => {
            throw new Error('storage broken');
          },
          set: async () => {
            throw new Error('storage broken');
          },
          remove: async () => {
            throw new Error('storage broken');
          },
        },
      },
    };
    await expect(appendError({ code: 'A', message: '甲', at: 10 })).resolves.toEqual([
      { code: 'A', message: '甲', at: 10, count: 1 },
    ]);
    expect(await loadErrorLog()).toEqual([]);
    await expect(clearErrorLog()).resolves.toBeUndefined();
  });
});
