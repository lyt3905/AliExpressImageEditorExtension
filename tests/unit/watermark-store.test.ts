import 'fake-indexeddb/auto';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_WATERMARK_BYTES, STORAGE_KEYS } from '../../src/shared/constants';
import { clearAll, resetDatabaseCache } from '../../src/services/indexed-db';
import {
  getDefaultWatermark,
  listWatermarks,
  loadWatermarkBlob,
  removeWatermark,
  renameWatermark,
  saveWatermark,
  setDefaultWatermark,
} from '../../src/services/watermark-store';

/**
 * The watermark store is exercised without a browser: `chrome.storage.local` is
 * stubbed in memory and `createImageBitmap` is stubbed so every blob "decodes"
 * to a known 800x800 frame.
 */
function installChromeStub(): void {
  const backing = new Map<string, unknown>();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      local: {
        get: async (key: string) => (backing.has(key) ? { [key]: backing.get(key) } : {}),
        set: async (values: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(values)) backing.set(key, value);
        },
      },
    },
  };
}

function imageBlob(bytes = 64, type = 'image/png'): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

beforeAll(() => {
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => ({
    width: 800,
    height: 800,
    close: () => undefined,
  });
});

describe('watermark-store', () => {
  beforeEach(async () => {
    installChromeStub();
    resetDatabaseCache();
    await clearAll();
  });

  it('starts empty', async () => {
    expect(await listWatermarks()).toEqual([]);
    expect(await getDefaultWatermark()).toBeNull();
  });

  it('makes the very first watermark the default automatically', async () => {
    const first = await saveWatermark(imageBlob(), '边框 A');
    const second = await saveWatermark(imageBlob(), '边框 B');

    expect(first.isDefault).toBe(true);
    expect(second.isDefault).toBe(false);

    const list = await listWatermarks();
    expect(list.map((entry) => entry.name)).toEqual(['边框 A', '边框 B']);
    expect(list.filter((entry) => entry.isDefault)).toHaveLength(1);
    expect((await getDefaultWatermark())?.id).toBe(first.id);
  });

  it('falls back to a generated name when none is given', async () => {
    expect((await saveWatermark(imageBlob(), '   ')).name).toBe('水印 1');
  });

  it('records the decoded pixel size', async () => {
    const meta = await saveWatermark(imageBlob(), 'A');
    expect(meta).toMatchObject({ width: 800, height: 800 });
  });

  it('rejects an empty file', async () => {
    await expect(saveWatermark(imageBlob(0), 'x')).rejects.toThrow('水印图片为空');
  });

  it('rejects an oversized file', async () => {
    await expect(saveWatermark(imageBlob(MAX_WATERMARK_BYTES + 1), 'x')).rejects.toThrow(/过大/);
  });

  it('rejects an unsupported mime type', async () => {
    const svg = imageBlob(32, 'image/svg+xml');
    await expect(saveWatermark(svg, 'x')).rejects.toThrow(/不支持的水印格式/);
  });

  it('keeps exactly one default and persists the switch', async () => {
    await saveWatermark(imageBlob(), 'A');
    const second = await saveWatermark(imageBlob(), 'B');

    const list = await setDefaultWatermark(second.id);
    expect(list.filter((entry) => entry.isDefault).map((entry) => entry.id)).toEqual([second.id]);
    expect(await listWatermarks()).toEqual(list);
  });

  it('renames without losing the default flag', async () => {
    const meta = await saveWatermark(imageBlob(), 'A');
    const list = await renameWatermark(meta.id, '新名字');
    expect(list[0]).toMatchObject({ id: meta.id, name: '新名字', isDefault: true });
  });

  it('keeps the old name when the rename is blank', async () => {
    const meta = await saveWatermark(imageBlob(), '原名');
    const list = await renameWatermark(meta.id, '  ');
    expect(list[0]?.name).toBe('原名');
  });

  it('promotes the next watermark when the default is deleted', async () => {
    const first = await saveWatermark(imageBlob(), 'A');
    const second = await saveWatermark(imageBlob(), 'B');

    const list = await removeWatermark(first.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: second.id, isDefault: true });
    expect((await getDefaultWatermark())?.id).toBe(second.id);
  });

  it('deletes the image blob along with the watermark', async () => {
    const meta = await saveWatermark(imageBlob(128), 'A');
    expect(await loadWatermarkBlob(meta)).toBeInstanceOf(Blob);

    await removeWatermark(meta.id);
    expect(await loadWatermarkBlob(meta)).toBeNull();
  });

  it('round-trips the blob bytes unchanged', async () => {
    const bytes = new Uint8Array([9, 8, 7, 6, 5, 4]);
    const meta = await saveWatermark(new Blob([bytes], { type: 'image/png' }), 'A');

    const blob = await loadWatermarkBlob(meta);
    expect(blob).not.toBeNull();
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(bytes);
  });

  it('ignores a corrupt stored list instead of throwing', async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.watermarks]: 'not-an-array' });
    expect(await listWatermarks()).toEqual([]);
    expect(await getDefaultWatermark()).toBeNull();
  });

  it('drops entries that do not look like watermark metadata', async () => {
    const meta = await saveWatermark(imageBlob(), 'A');
    await chrome.storage.local.set({
      [STORAGE_KEYS.watermarks]: [meta, { id: 'broken' }, null, 42],
    });
    expect(await listWatermarks()).toEqual([meta]);
  });
});
