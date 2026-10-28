import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_VISION_BASE_URL, STORAGE_KEYS } from '../../src/shared/constants';
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
  /*
    Storage keeps what the user typed; the "empty key means use the built-in one"
    rule now resolves in `resolveVisionConfigs()` at request time (see
    `tests/unit/vision-endpoints.test.ts`). Written down here because it looks like
    a regression: a stored `''` no longer reads back as the default key. It must
    not — the Options page has to show the field the user left blank, and the
    request-time resolution still prevents the 401 trap.
  */
  it('returns a single default row when nothing is stored', async () => {
    stubStoredSettings(undefined);
    const { vision } = await loadSettings();
    expect(vision).toEqual([{ baseUrl: DEFAULT_VISION_BASE_URL, model: '', apiKey: '' }]);
  });

  it('keeps an empty stored key empty instead of faking the default', async () => {
    stubStoredSettings({ serverUrl: 'https://x.test', username: 'u', vision: { apiKey: '' } });
    const [main] = (await loadSettings()).vision;
    expect(main).toMatchObject({ apiKey: '' });
  });

  it('trims a whitespace-only key down to empty', async () => {
    stubStoredSettings({ vision: { baseUrl: 'http://a.test/v1', apiKey: '   ' } });
    const [main] = (await loadSettings()).vision;
    expect(main).toMatchObject({ apiKey: '' });
  });

  it('lets a saved key win, trimmed', async () => {
    stubStoredSettings({ vision: { baseUrl: 'http://a.test/v1', apiKey: '   saved-key  ' } });
    const [main] = (await loadSettings()).vision;
    expect(main).toMatchObject({ apiKey: 'saved-key' });
  });

  it('keeps the stored base URL and leaves the model for request time', async () => {
    stubStoredSettings({ vision: { baseUrl: 'http://10.0.0.5:8788/v1' } });
    const [main] = (await loadSettings()).vision;
    expect(main).toEqual({ baseUrl: 'http://10.0.0.5:8788/v1', model: '', apiKey: '' });
  });

  it('upgrades a legacy single-object block into a one-row chain', async () => {
    // 10.8.x stored `{ baseUrl, model, apiKey }`. Anyone who updates keeps working.
    stubStoredSettings({
      vision: { baseUrl: 'http://a.test/v1', model: 'm', apiKey: 'k' },
    });
    expect((await loadSettings()).vision).toEqual([
      { baseUrl: 'http://a.test/v1', model: 'm', apiKey: 'k' },
    ]);
  });

  it('keeps the rows in order and drops rows without an address', async () => {
    stubStoredSettings({
      vision: [
        { baseUrl: 'http://a.test/v1', model: 'm', apiKey: 'k' },
        { baseUrl: '', model: 'nope' },
        { baseUrl: ' http://b.test/v1 ', model: '', apiKey: '' },
      ],
    });
    expect((await loadSettings()).vision).toEqual([
      { baseUrl: 'http://a.test/v1', model: 'm', apiKey: 'k' },
      { baseUrl: 'http://b.test/v1', model: '', apiKey: '' },
    ]);
  });

  it('ignores junk in the vision field instead of throwing', async () => {
    stubStoredSettings({ vision: 'nope' });
    expect((await loadSettings()).vision).toEqual([
      { baseUrl: DEFAULT_VISION_BASE_URL, model: '', apiKey: '' },
    ]);
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
    vision: { baseUrl: string; model: string; apiKey: string }[];
  };

  it('patches the MAIN gateway and keeps the backups behind it', async () => {
    const read = stubStore({
      serverUrl: 'https://x.test',
      username: 'u',
      vision: [
        { baseUrl: 'http://10.0.0.5:8788/v1', model: 'm-1', apiKey: 'old-key' },
        { baseUrl: 'http://10.0.0.9:8788/v1', model: '', apiKey: '' },
      ],
    });
    const next = await saveSettings({ vision: { apiKey: 'new-key' } });
    expect(next.vision).toEqual([
      { baseUrl: 'http://10.0.0.5:8788/v1', model: 'm-1', apiKey: 'new-key' },
      { baseUrl: 'http://10.0.0.9:8788/v1', model: '', apiKey: '' },
    ]);
    expect((read() as Stored).vision[0]!.apiKey).toBe('new-key');
  });

  it('replaces the whole chain when a list is saved', async () => {
    // Removal has to be expressible: the Options page sends the list it shows.
    const read = stubStore({
      vision: [
        { baseUrl: 'http://a.test/v1', model: '', apiKey: '' },
        { baseUrl: 'http://b.test/v1', model: '', apiKey: '' },
      ],
    });
    await saveSettings({ vision: [{ baseUrl: 'http://c.test/v1', model: 'm', apiKey: 'k' }] });
    expect((read() as Stored).vision).toEqual([
      { baseUrl: 'http://c.test/v1', model: 'm', apiKey: 'k' },
    ]);
  });

  it('does not blank the account fields when only vision is saved', async () => {
    const read = stubStore({ serverUrl: 'https://x.test', username: 'seller', vision: {} });
    await saveSettings({
      vision: [{ baseUrl: 'http://127.0.0.1:8788/v1', model: 'qwen-vl', apiKey: 'k' }],
    });
    const stored = read() as Stored;
    expect(stored.serverUrl).toBe('https://x.test');
    expect(stored.username).toBe('seller');
    expect(stored.vision).toEqual([
      { baseUrl: 'http://127.0.0.1:8788/v1', model: 'qwen-vl', apiKey: 'k' },
    ]);
  });

  it('trims what it stores and keeps a blanked key blank', async () => {
    // Storing the default key here would make the Options field lie about what the
    // user typed; the default is applied per request instead.
    stubStore({ vision: { baseUrl: 'http://a.test/v1', model: 'm', apiKey: 'old' } });
    const next = await saveSettings({ vision: { baseUrl: '  http://b.test/v1  ', apiKey: '   ' } });
    expect(next.vision).toEqual([
      { baseUrl: 'http://b.test/v1', model: 'm', apiKey: '' },
    ]);
  });
});
