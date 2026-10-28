import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_VISION_API_KEY, DEFAULT_VISION_MODEL, STORAGE_KEYS } from '../../src/shared/constants';
import { loadSettings, saveSettings } from '../../src/services/settings';

/**
 * `loadSettings` reads `chrome.storage.local`; only that one call is stubbed, so
 * these tests pin the merge rules rather than the browser.
 */
function stubStoredSettings(value: unknown): void {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) =>
          value === undefined ? {} : { [key]: value },
      },
    },
  };
}

afterEach(() => {
  delete (globalThis as unknown as { chrome?: unknown }).chrome;
});

describe('loadSettings — vision block', () => {
  it('falls back to the build-time default key when nothing is stored', () => {
    // In CI there is no `.env.local`, so this default is ''. On a developer machine
    // it is their own key. Either way the assertion is about WIRING, not the value.
    stubStoredSettings(undefined);
    return expect(loadSettings()).resolves.toMatchObject({
      vision: { apiKey: DEFAULT_VISION_API_KEY, model: DEFAULT_VISION_MODEL },
    });
  });

  it('falls back to the default when the stored key is EMPTY', () => {
    // The trap this guards: the Options page saves all three vision fields together,
    // so one "仅保存设置" click taken before a key existed persists `''`. Honouring
    // that literally would shadow every future default while the field looks
    // configured — and every request would go out unauthenticated (HTTP 401).
    stubStoredSettings({ serverUrl: 'https://x.test', username: 'u', vision: { apiKey: '' } });
    return expect(loadSettings()).resolves.toMatchObject({
      vision: { apiKey: DEFAULT_VISION_API_KEY },
    });
  });

  it('falls back when the stored key is only whitespace', () => {
    stubStoredSettings({ vision: { apiKey: '   ' } });
    return expect(loadSettings()).resolves.toMatchObject({
      vision: { apiKey: DEFAULT_VISION_API_KEY },
    });
  });

  it('lets a saved key win over the default', () => {
    stubStoredSettings({ vision: { apiKey: '   saved-key  ' } });
    return expect(loadSettings()).resolves.toMatchObject({
      vision: { apiKey: 'saved-key' },
    });
  });

  it('keeps stored base URL and model, filling anything absent', () => {
    stubStoredSettings({ vision: { baseUrl: 'http://10.0.0.5:8788/v1' } });
    return expect(loadSettings()).resolves.toMatchObject({
      vision: { baseUrl: 'http://10.0.0.5:8788/v1', model: DEFAULT_VISION_MODEL },
    });
  });
});

describe('loadSettings — the storage key stays put', () => {  it('reads exactly the key the rest of the extension writes', async () => {
    let asked = '';
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => {
            asked = key;
            return {};
          },
        },
      },
    };
    await loadSettings();
    expect(asked).toBe(STORAGE_KEYS.settings);
  });
});

/**
 * The bug these pin: the Options page has always sent `vision` with every save,
 * but the background handler dropped it before calling `saveSettings`, so the
 * three inputs looked editable and silently reverted on the next page load.
 * These cases fix the contract the handler must keep — a `vision` patch is
 * merged into what is stored, never used to blank the sibling fields.
 */
describe('saveSettings — vision patches are merged', () => {
  function stubStore(initial: unknown): () => unknown {
    let stored: unknown = initial;
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: {
        local: {
          get: async (key: string) => (stored === undefined ? {} : { [key]: stored }),
          set: async (values: Record<string, unknown>) => {
            stored = values[STORAGE_KEYS.settings];
          },
        },
      },
    };
    return () => stored;
  }

  type Stored = {
    serverUrl: string;
    username: string;
    vision: { baseUrl: string; model: string; apiKey: string };
  };

  it('keeps the other two vision fields when only the key is patched', async () => {
    const read = stubStore({
      serverUrl: 'https://x.test',
      username: 'u',
      vision: { baseUrl: 'http://10.0.0.5:8788/v1', model: 'm-1', apiKey: 'old-key' },
    });
    const next = await saveSettings({ vision: { apiKey: 'new-key' } });
    expect(next.vision).toEqual({ baseUrl: 'http://10.0.0.5:8788/v1', model: 'm-1', apiKey: 'new-key' });
    expect((read() as Stored).vision.apiKey).toBe('new-key');
  });

  it('does not blank the account fields when only vision is saved', async () => {
    const read = stubStore({ serverUrl: 'https://x.test', username: 'seller', vision: {} });
    await saveSettings({ vision: { baseUrl: 'http://127.0.0.1:8788/v1', model: 'qwen-vl', apiKey: 'k' } });
    const stored = read() as Stored;
    expect(stored.serverUrl).toBe('https://x.test');
    expect(stored.username).toBe('seller');
    expect(stored.vision).toEqual({ baseUrl: 'http://127.0.0.1:8788/v1', model: 'qwen-vl', apiKey: 'k' });
  });

  it('trims what it stores and falls back to the default for an emptied key', async () => {
    stubStore({ vision: { baseUrl: 'http://a.test/v1', model: 'm', apiKey: 'old' } });
    const next = await saveSettings({ vision: { baseUrl: '  http://b.test/v1  ', apiKey: '   ' } });
    expect(next.vision).toEqual({
      baseUrl: 'http://b.test/v1',
      model: 'm',
      apiKey: DEFAULT_VISION_API_KEY,
    });
  });
});
