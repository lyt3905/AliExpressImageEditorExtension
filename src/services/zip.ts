/**
 * Minimal ZIP writer — store method only (no compression).
 *
 * Why hand-rolled: the export feature has to produce a `catalog/`-shaped bundle
 * (a `brands.json` plus a few PNGs) from inside a Chrome extension page. Pulling in
 * a zip library for that would add a dependency to a repo that has none, for output
 * that is a few hundred kilobytes at most. Storing uncompressed is a deliberate
 * trade: logos are already-compressed images, so deflate would save almost nothing
 * and cost us a compressor.
 *
 * What it produces is a plain, widely readable ZIP: local file headers, a central
 * directory, and an end-of-central-directory record. UTF-8 name flag (bit 11) is
 * set so an entry name with non-ASCII characters survives in tools that honour it.
 */

export interface ZipEntry {
  /** Path inside the archive, `/` separated, e.g. `logos/morph-toys.png`. */
  path: string;
  bytes: Uint8Array;
  /** Modified time to record. Defaults to now — only used for display. */
  date?: Date;
}

const LOCAL_HEADER_SIZE = 30;
const CENTRAL_HEADER_SIZE = 46;
const EOCD_SIZE = 22;
/** Version 2.0: the minimum that still reads fine everywhere. */
const VERSION_NEEDED = 20;
/** Bit 11 — entry names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;

let crcTable: Uint32Array | null = null;

function table(): Uint32Array {
  if (crcTable) return crcTable;
  const next = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    next[index] = value >>> 0;
  }
  crcTable = next;
  return next;
}

/** CRC-32 of the given bytes, as an unsigned integer. */
export function crc32(bytes: Uint8Array): number {
  const lookup = table();
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = lookup[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** MS-DOS date/time pair (local time, 2-second resolution). */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time:
      (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

class Writer {
  private offset = 0;
  private readonly chunks: Uint8Array[] = [];

  get position(): number {
    return this.offset;
  }

  push(bytes: Uint8Array): void {
    this.chunks.push(bytes);
    this.offset += bytes.length;
  }

  blob(type = 'application/zip'): Blob {
    return new Blob(this.chunks as BlobPart[], { type });
  }
}

/**
 * Build the archive.
 *
 * Entry order is preserved, and duplicate paths are rejected outright: two entries
 * with the same name in a bundle meant for a static host is always a mistake, and
 * silently writing both leaves the outcome up to the unzip tool.
 */
export function createZip(entries: readonly ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const writer = new Writer();
  const seen = new Set<string>();
  const central: Uint8Array[] = [];
  let count = 0;

  for (const entry of entries) {
    if (seen.has(entry.path)) {
      throw new Error(`压缩包里出现重复路径：${entry.path}`);
    }
    seen.add(entry.path);

    const name = encoder.encode(entry.path);
    const crc = crc32(entry.bytes);
    const stamp = dosDateTime(entry.date ?? new Date());
    const size = entry.bytes.length;
    const localOffset = writer.position;

    const local = new Uint8Array(LOCAL_HEADER_SIZE);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); // PK\x03\x04
    localView.setUint16(4, VERSION_NEEDED, true);
    localView.setUint16(6, FLAG_UTF8, true);
    localView.setUint16(8, METHOD_STORE, true);
    localView.setUint16(10, stamp.time, true);
    localView.setUint16(12, stamp.date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, name.length, true);
    localView.setUint16(28, 0, true); // no extra field

    writer.push(local);
    writer.push(name);
    writer.push(entry.bytes);

    const header = new Uint8Array(CENTRAL_HEADER_SIZE);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x02014b50, true); // PK\x01\x02
    headerView.setUint16(4, VERSION_NEEDED, true); // made by
    headerView.setUint16(6, VERSION_NEEDED, true); // needed
    headerView.setUint16(8, FLAG_UTF8, true);
    headerView.setUint16(10, METHOD_STORE, true);
    headerView.setUint16(12, stamp.time, true);
    headerView.setUint16(14, stamp.date, true);
    headerView.setUint32(16, crc, true);
    headerView.setUint32(20, size, true);
    headerView.setUint32(24, size, true);
    headerView.setUint16(28, name.length, true);
    headerView.setUint16(30, 0, true); // extra
    headerView.setUint16(32, 0, true); // comment
    headerView.setUint16(34, 0, true); // disk number
    headerView.setUint16(36, 0, true); // internal attrs
    headerView.setUint32(38, 0, true); // external attrs
    headerView.setUint32(42, localOffset, true);

    central.push(header, name);
    count += 1;
  }

  const centralOffset = writer.position;
  let centralSize = 0;
  for (const chunk of central) {
    writer.push(chunk);
    centralSize += chunk.length;
  }

  const end = new Uint8Array(EOCD_SIZE);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // PK\x05\x06
  endView.setUint16(4, 0, true); // this disk
  endView.setUint16(6, 0, true); // disk with central directory
  endView.setUint16(8, count, true);
  endView.setUint16(10, count, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true); // comment length
  writer.push(end);

  return writer.blob();
}

/**
 * Read back the entry list of an archive produced by `createZip`.
 *
 * Only used by the tests, but it parses the real bytes (central directory), so it
 * catches the mistakes a "does it start with PK" assertion would miss.
 */
export function listZipEntries(
  bytes: Uint8Array,
): Array<{ path: string; size: number; crc: number; offset: number; dataOffset: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const out: Array<{ path: string; size: number; crc: number; offset: number }> = [];

  // Find the end-of-central-directory record from the tail.
  let eocd = -1;
  for (let index = bytes.length - EOCD_SIZE; index >= 0; index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) throw new Error('找不到 ZIP 目录尾部');

  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('中央目录签名不对');
    const crc = view.getUint32(cursor + 16, true);
    const size = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const offset = view.getUint32(cursor + 42, true);
    const name = decoder.decode(bytes.subarray(cursor + CENTRAL_HEADER_SIZE, cursor + CENTRAL_HEADER_SIZE + nameLength));
    out.push({
    path: name,
    size,
    crc,
    offset,
    dataOffset: offset + LOCAL_HEADER_SIZE + nameLength,
  });
    cursor += CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength;
  }
  return out;
}
