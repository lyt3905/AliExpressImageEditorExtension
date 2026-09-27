import 'fake-indexeddb/auto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAX_UPLOAD_BYTES } from '../../src/shared/constants';
import type { EditorSessionRecord, SessionImage } from '../../src/shared/types';
import { clearAll, getBlob, getSession, resetDatabaseCache } from '../../src/services/indexed-db';
import {
  UPLOAD_DEFAULT_LABEL,
  UPLOAD_ID_PREFIX,
  appendUploadedImages,
  createUploadImageId,
  describeUploadOutcome,
  describeUploadSize,
} from '../../src/services/upload-images';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const TEXT = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);

/** `readBlobSize` goes through `createImageBitmap`; stub it per test. */
let decodeSize = { width: 800, height: 600 };

/** The inferred `Uint8Array<ArrayBuffer>` shape, so it stays a valid `BlobPart`. */
type Bytes = typeof PNG;

function imageBlob(bytes: Bytes = PNG, type = 'image/png'): Blob {
  return new Blob([bytes], { type });
}

/** A `Blob` that only reports a size — enough to exercise the size guard. */
function sizedBlob(size: number, type = 'image/png'): Blob {
  return { size, type } as unknown as Blob;
}

function makeImage(overrides: Partial<SessionImage> & { id: string }): SessionImage {
  return {
    index: 0,
    blobId: overrides.id,
    url: 'https://ae01.alicdn.com/kf/A.jpg',
    width: 800,
    height: 800,
    selected: true,
    cutoutStatus: 'success',
    ...overrides,
  };
}

function makeRecord(images: SessionImage[] = []): EditorSessionRecord {
  return {
    id: 'sess-test',
    createdAt: 1_700_000_000_000,
    sourceTabId: 7,
    sourceUrl: 'https://seller.aliexpress.com/product/x',
    imageIds: images.map((image) => image.id),
    images,
  };
}

beforeAll(() => {
  (globalThis as unknown as { createImageBitmap: unknown }).createImageBitmap = async () => ({
    width: decodeSize.width,
    height: decodeSize.height,
    close: () => undefined,
  });
});

describe('upload-images', () => {
  beforeEach(async () => {
    decodeSize = { width: 800, height: 600 };
    resetDatabaseCache();
    await clearAll();
  });

  afterEach(() => {
    decodeSize = { width: 800, height: 600 };
  });

  it('appends an image, stores the blob and keeps the record in sync', async () => {
    const outcome = await appendUploadedImages(makeRecord(), [{ name: 'front.png', blob: imageBlob() }]);

    expect(outcome.rejected).toEqual([]);
    expect(outcome.added).toHaveLength(1);

    const [added] = outcome.added;
    expect(added?.id.startsWith(UPLOAD_ID_PREFIX)).toBe(true);
    expect(added).toMatchObject({
      index: 0,
      width: 800,
      height: 600,
      label: 'front.png',
      // Selected + idle is what makes the automatic pipeline pick it up.
      selected: true,
      cutoutStatus: 'idle',
    });
    expect(added?.blobId).toBe(added?.id);
    expect(outcome.record.imageIds).toEqual([added?.id]);

    // The blob really landed in IndexedDB, not just in the returned object.
    const stored = await getBlob(added?.id as string);
    expect(stored).toBeInstanceOf(Blob);
    expect(stored?.size).toBe(PNG.length);

    const persisted = await getSession('sess-test');
    expect(persisted?.images.map((image) => image.id)).toEqual([added?.id]);
  });

  it('continues the page numbering and leaves existing images alone', async () => {
    const existing = makeImage({ id: 'hash-a', index: 0, cutoutStatus: 'success', cutoutBlobId: 'hash-a-cutout' });
    const outcome = await appendUploadedImages(makeRecord([existing]), [
      { name: 'a.png', blob: imageBlob() },
      { name: 'b.png', blob: imageBlob() },
    ]);

    expect(outcome.added.map((image) => image.index)).toEqual([1, 2]);
    expect(outcome.record.images).toHaveLength(3);
    expect(outcome.record.images[0]).toEqual(existing);
    expect(outcome.record.imageIds).toEqual(['hash-a', outcome.added[0]?.id, outcome.added[1]?.id]);
  });

  it('accepts a nameless screenshot paste by sniffing the bytes', async () => {
    // No declared type at all — the clipboard case.
    const outcome = await appendUploadedImages(makeRecord(), [{ name: '', blob: imageBlob(PNG, '') }]);

    expect(outcome.rejected).toEqual([]);
    expect(outcome.added[0]?.label).toBe(UPLOAD_DEFAULT_LABEL);
    // The stored blob carries a real mime so the cutout request is well-formed.
    expect((await getBlob(outcome.added[0]?.id as string))?.type).toBe('image/png');
  });

  it('rejects an empty file', async () => {
    const outcome = await appendUploadedImages(makeRecord(), [{ name: 'empty.png', blob: imageBlob(new Uint8Array([])) }]);

    expect(outcome.added).toEqual([]);
    expect(outcome.rejected).toEqual([{ name: 'empty.png', reason: '文件为空' }]);
    // Nothing was written, so the record is untouched.
    expect(await getSession('sess-test')).toBeNull();
  });

  it('rejects an oversized file before reading it', async () => {
    const outcome = await appendUploadedImages(makeRecord(), [
      { name: 'huge.png', blob: sizedBlob(MAX_UPLOAD_BYTES + 1) },
    ]);

    expect(outcome.rejected[0]?.name).toBe('huge.png');
    expect(outcome.rejected[0]?.reason).toMatch(/超过 20MB 上限/);
  });

  it('rejects a non-image disguised as a png', async () => {
    const outcome = await appendUploadedImages(makeRecord(), [{ name: 'notes.txt', blob: imageBlob(TEXT, 'text/plain') }]);

    expect(outcome.added).toEqual([]);
    expect(outcome.rejected[0]?.reason).toMatch(/不是支持的图片格式/);
  });

  it('rejects an image whose size cannot be decoded', async () => {
    decodeSize = { width: 0, height: 0 };
    const outcome = await appendUploadedImages(makeRecord(), [{ name: 'broken.png', blob: imageBlob() }]);

    expect(outcome.added).toEqual([]);
    expect(outcome.rejected).toEqual([{ name: 'broken.png', reason: '无法解析图片尺寸' }]);
  });

  it('keeps the good files when one of them is bad', async () => {
    const outcome = await appendUploadedImages(makeRecord(), [
      { name: 'good-1.png', blob: imageBlob() },
      { name: 'bad.txt', blob: imageBlob(TEXT, 'text/plain') },
      { name: 'good-2.png', blob: imageBlob() },
    ]);

    expect(outcome.added.map((image) => image.label)).toEqual(['good-1.png', 'good-2.png']);
    expect(outcome.rejected.map((entry) => entry.name)).toEqual(['bad.txt']);
    expect(outcome.record.images).toHaveLength(2);
    expect(outcome.record.imageIds).toEqual(outcome.added.map((image) => image.id));
  });

  it('does not mutate the record it was given', async () => {
    const record = makeRecord([makeImage({ id: 'hash-a' })]);
    const before = JSON.stringify(record);

    await appendUploadedImages(record, [{ name: 'a.png', blob: imageBlob() }]);

    expect(JSON.stringify(record)).toBe(before);
  });

  it('re-derives imageIds so a drifted array self-heals', async () => {
    const record: EditorSessionRecord = { ...makeRecord([makeImage({ id: 'hash-a' })]), imageIds: ['hash-a', 'ghost'] };
    const outcome = await appendUploadedImages(record, [{ name: 'a.png', blob: imageBlob() }]);

    expect(outcome.record.imageIds).toEqual(['hash-a', outcome.added[0]?.id]);
  });

  it('writes nothing when there is no candidate at all', async () => {
    const record = makeRecord([makeImage({ id: 'hash-a' })]);
    const outcome = await appendUploadedImages(record, []);

    expect(outcome.record).toBe(record);
    expect(outcome.added).toEqual([]);
    expect(await getSession('sess-test')).toBeNull();
  });

  it('creates prefixed ids that never repeat', () => {
    const taken = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const id = createUploadImageId(taken);
      expect(id.startsWith(UPLOAD_ID_PREFIX)).toBe(true);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
    expect(taken.size).toBe(200);
  });

  it('re-rolls when the candidate id is already taken', () => {
    // Freeze both sources of entropy so the loop is forced to run: the first two
    // draws produce an identical candidate, the third one is different.
    const originalNow = Date.now;
    const originalRandom = Math.random;
    let draw = 0;
    Date.now = () => 1;
    Math.random = () => {
      draw += 1;
      return draw <= 2 ? 0.5 : 0.25;
    };

    try {
      const taken = new Set<string>([createUploadImageId(new Set<string>())]);
      expect(taken.size).toBe(1);

      const next = createUploadImageId(taken);
      expect(taken.has(next)).toBe(false);
      // Two colliding draws plus the one that finally succeeded.
      expect(draw).toBe(3);
    } finally {
      Date.now = originalNow;
      Math.random = originalRandom;
    }
  });
});

describe('describeUploadOutcome', () => {
  const record = makeRecord();

  it('reports a clean batch as success', () => {
    const result = describeUploadOutcome({
      record,
      added: [{ id: 'a' } as SessionImage],
      rejected: [],
    });
    expect(result.kind).toBe('ok');
    expect(result.text).toBe('已添加 1 张图片，正在自动抠图');
  });

  it('reports a fully rejected batch as an error with reasons', () => {
    const result = describeUploadOutcome({
      record,
      added: [],
      rejected: [{ name: 'a.txt', reason: '不是支持的图片格式' }],
    });
    expect(result.kind).toBe('error');
    expect(result.text).toContain('a.txt（不是支持的图片格式）');
  });

  it('flags a partial batch so the skipped files are not missed', () => {
    const result = describeUploadOutcome({
      record,
      added: [{ id: 'a' } as SessionImage, { id: 'b' } as SessionImage],
      rejected: [{ name: 'big.png', reason: '超过 20MB 上限' }],
    });
    expect(result.kind).toBe('error');
    expect(result.text).toContain('已添加 2 张图片');
    expect(result.text).toContain('已跳过 1 张');
  });

  it('says nothing was addable when the clipboard had no image', () => {
    expect(describeUploadOutcome({ record, added: [], rejected: [] })).toEqual({
      kind: 'ok',
      text: '没有可添加的图片',
    });
  });

  it('formats sizes for humans', () => {
    expect(describeUploadSize(1024 * 1024)).toBe('1.0MB');
    expect(describeUploadSize(23 * 1024 * 1024)).toBe('23.0MB');
  });
});
