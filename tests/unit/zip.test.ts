import { describe, expect, it } from 'vitest';
import { createZip, crc32, listZipEntries } from '../../src/services/zip';

const encoder = new TextEncoder();

function bytesOf(text: string): Uint8Array {
  return encoder.encode(text);
}

async function bytesOfBlob(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Read one entry back out of the archive using the central directory. */
function readEntry(archive: Uint8Array, path: string): Uint8Array {
  const entry = listZipEntries(archive).find((item) => item.path === path);
  if (!entry) throw new Error(`压缩包里没有 ${path}`);
  return archive.subarray(entry.dataOffset, entry.dataOffset + entry.size);
}

describe('crc32', () => {
  it('matches the reference values', () => {
    // "123456789" is the canonical CRC-32 check value.
    expect(crc32(bytesOf('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array([]))).toBe(0);
  });
});

describe('createZip', () => {
  it('writes a readable archive with the entries it was given', async () => {
    const archive = await bytesOfBlob(
      createZip([
        { path: 'brands.json', bytes: bytesOf('{"version":1}') },
        { path: 'logos/a.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]) },
      ]),
    );

    const entries = listZipEntries(archive);
    expect(entries.map((entry) => entry.path)).toEqual(['brands.json', 'logos/a.png']);
    expect(new TextDecoder().decode(readEntry(archive, 'brands.json'))).toBe('{"version":1}');
    expect(readEntry(archive, 'logos/a.png')).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  });

  it('records the size and crc32 of each entry', async () => {
    const payload = bytesOf('hello 世界');
    const archive = await bytesOfBlob(createZip([{ path: 'a.txt', bytes: payload }]));
    const [entry] = listZipEntries(archive);

    expect(entry?.size).toBe(payload.length);
    expect(entry?.crc).toBe(crc32(payload));
  });

  it('starts with a local file header and ends with an EOCD record', async () => {
    const archive = await bytesOfBlob(createZip([{ path: 'a.txt', bytes: bytesOf('x') }]));

    expect([...archive.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect([...archive.subarray(archive.length - 22, archive.length - 18)]).toEqual([
      0x50, 0x4b, 0x05, 0x06,
    ]);
  });

  it('rejects two entries with the same path', () => {
    // 静默写两条同名记录等于把结果交给解压工具决定，是有损的行为。
    expect(() =>
      createZip([
        { path: 'logos/a.png', bytes: new Uint8Array([1]) },
        { path: 'logos/a.png', bytes: new Uint8Array([2]) },
      ]),
    ).toThrow(/重复路径/);
  });

  it('keeps an empty archive legal', async () => {
    const archive = await bytesOfBlob(createZip([]));
    expect(archive.length).toBe(22);
    expect(listZipEntries(archive)).toEqual([]);
  });
});
