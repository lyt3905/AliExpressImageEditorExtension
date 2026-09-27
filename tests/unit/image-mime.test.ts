import { describe, expect, it } from 'vitest';
import {
  DECLARED_IMAGE_MIME,
  MIME_SNIFF_BYTES,
  SUPPORTED_IMAGE_MIME_HINT,
  SUPPORTED_IMAGE_MIME_TYPES,
  resolveImageMime,
  sniffImageMime,
} from '../../src/shared/image-mime';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const TEXT = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e]);

/** The inferred `Uint8Array<ArrayBuffer>` shape, so it stays a valid `BlobPart`. */
type Bytes = typeof PNG;

function blobOf(bytes: Bytes = PNG, type = ''): Blob {
  return new Blob([bytes], { type });
}

describe('sniffImageMime', () => {
  it('recognises png / jpeg / webp magic numbers', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(WEBP)).toBe('image/webp');
  });

  it('returns null for an empty or unknown payload', () => {
    expect(sniffImageMime(new Uint8Array([]))).toBeNull();
    expect(sniffImageMime(TEXT)).toBeNull();
    expect(sniffImageMime(GIF)).toBeNull();
    expect(sniffImageMime(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it('needs the full signature, not just the prefix', () => {
    // "RIFF" alone is also what a .wav starts with, so the WEBP tag is required.
    expect(sniffImageMime(WEBP.slice(0, 8))).toBeNull();
    // 7 bytes of the PNG signature must not be enough either.
    expect(sniffImageMime(PNG.slice(0, 7))).toBeNull();
  });

  it('probes no more than MIME_SNIFF_BYTES', () => {
    const padded = new Uint8Array(MIME_SNIFF_BYTES);
    padded.set(PNG);
    expect(sniffImageMime(padded)).toBe('image/png');
  });
});

describe('DECLARED_IMAGE_MIME', () => {
  it('accepts the whitelist, including the jpg alias and mixed case', () => {
    for (const type of ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'IMAGE/PNG']) {
      expect(DECLARED_IMAGE_MIME.test(type), type).toBe(true);
    }
  });

  it('rejects everything else', () => {
    for (const type of ['', 'image/gif', 'image/svg+xml', 'text/plain', 'application/octet-stream']) {
      expect(DECLARED_IMAGE_MIME.test(type), type).toBe(false);
    }
  });

  it('keeps the picker whitelist and the hint in step', () => {
    for (const type of SUPPORTED_IMAGE_MIME_TYPES) {
      expect(DECLARED_IMAGE_MIME.test(type), type).toBe(true);
    }
    expect(SUPPORTED_IMAGE_MIME_TYPES).toHaveLength(3);
    expect(SUPPORTED_IMAGE_MIME_HINT).toBe('PNG / JPEG / WebP');
  });
});

describe('resolveImageMime', () => {
  it('trusts a whitelisted declared type without sniffing', async () => {
    // The bytes are text on purpose: the declared type wins and no read happens.
    await expect(resolveImageMime(blobOf(TEXT, 'image/png'))).resolves.toBe('image/png');
  });

  it('sniffs when the declared type is generic or blank', async () => {
    await expect(resolveImageMime(blobOf(JPEG, 'application/octet-stream'))).resolves.toBe('image/jpeg');
    // A raw screenshot paste: no name, no declared mime.
    await expect(resolveImageMime(blobOf(PNG, ''))).resolves.toBe('image/png');
  });

  it('rejects a non-image payload instead of trusting the extension', async () => {
    await expect(resolveImageMime(blobOf(TEXT, 'text/plain'))).resolves.toBeNull();
    await expect(resolveImageMime(blobOf(GIF, 'image/gif'))).resolves.toBeNull();
    await expect(resolveImageMime(blobOf(TEXT, ''))).resolves.toBeNull();
  });
});
