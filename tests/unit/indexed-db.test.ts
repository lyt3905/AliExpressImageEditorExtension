import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearAll,
  getBlob,
  getSession,
  openDatabase,
  patchSessionImage,
  putBlob,
  putSession,
  resetDatabaseCache,
} from '../../src/services/indexed-db';
import type { EditorSessionRecord, SessionImage } from '../../src/shared/types';

function makeImage(id: string): SessionImage {
  return {
    id,
    index: 0,
    blobId: `blob-${id}`,
    url: `https://ae01.alicdn.com/kf/${id}.jpg`,
    width: 800,
    height: 800,
    selected: true,
    cutoutStatus: 'idle',
  };
}

function makeRecord(): EditorSessionRecord {
  const images = [makeImage('img-a'), makeImage('img-b')];
  return {
    id: 'sess-1',
    createdAt: 1_700_000_000_000,
    sourceTabId: 7,
    sourceUrl: 'https://seller.aliexpress.com/product/publish.htm',
    imageIds: images.map((image) => image.id),
    images,
  };
}

describe('indexed-db', () => {
  beforeEach(async () => {
    await clearAll();
  });

  it('opens a v1 database with the blobs and images stores', async () => {
    const db = await openDatabase();
    expect(Array.from(db.objectStoreNames).sort()).toEqual(['blobs', 'images']);
  });

  it('writes and reads a Blob payload unchanged', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const blob = new Blob([bytes], { type: 'image/png' });

    await putBlob('blob-1', blob);
    const restored = await getBlob('blob-1');

    expect(restored).toBeInstanceOf(Blob);
    expect(restored?.type).toBe('image/png');
    expect(restored?.size).toBe(bytes.length);
    expect(new Uint8Array(await restored!.arrayBuffer())).toEqual(bytes);
  });

  it('returns null for a missing blob', async () => {
    expect(await getBlob('nope')).toBeNull();
  });

  it('round-trips a session record', async () => {
    const record = makeRecord();
    await putSession(record);
    const restored = await getSession('sess-1');
    expect(restored).toEqual(record);
    expect(restored?.imageIds).toEqual(['img-a', 'img-b']);
  });

  it('returns null for a missing session', async () => {
    expect(await getSession('missing')).toBeNull();
  });

  it('patches a single image without dropping the others', async () => {
    const record = makeRecord();
    await putSession(record);

    const updated = await patchSessionImage('sess-1', 'img-a', {
      cutoutStatus: 'success',
      cutoutBlobId: 'blob-img-a-cutout',
      cutoutWidth: 640,
      cutoutHeight: 640,
    });

    expect(updated?.images).toHaveLength(2);
    expect(updated?.images[0]).toMatchObject({
      id: 'img-a',
      cutoutStatus: 'success',
      cutoutBlobId: 'blob-img-a-cutout',
    });
    expect(updated?.images[1]?.cutoutStatus).toBe('idle');

    const reloaded = await getSession('sess-1');
    expect(reloaded?.images[0]?.cutoutStatus).toBe('success');
  });

  it('is a no-op patch for a missing session', async () => {
    expect(await patchSessionImage('missing', 'img-a', { cutoutStatus: 'failed' })).toBeNull();
  });

  it('reuses one connection across calls', async () => {
    const first = await openDatabase();
    const second = await openDatabase();
    expect(first).toBe(second);
    resetDatabaseCache();
    const third = await openDatabase();
    expect(third).not.toBe(first);
  });
});
