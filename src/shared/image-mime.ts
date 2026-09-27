/**
 * Image mime detection, shared by the service worker and the editor page.
 *
 * The rule is the same on both sides, which is the whole point of this module:
 * a declared mime inside the whitelist is trusted as-is, otherwise the first
 * bytes are sniffed. `application/octet-stream` responses and clipboard items
 * with a blank `type` both go down the sniffing path.
 *
 * It lives in `shared/` because the editor page (local uploads, clipboard
 * paste) must not import from `background/`, which is service-worker-only.
 */

/** Whitelist for a declared mime. `image/jpg` is a common non-standard alias. */
export const DECLARED_IMAGE_MIME = /^image\/(jpeg|jpg|png|webp)$/i;

/** Offered to the file picker's `accept` attribute (order = display order). */
export const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Human-readable form used in rejection messages. */
export const SUPPORTED_IMAGE_MIME_HINT = 'PNG / JPEG / WebP';

/**
 * Probe the first bytes so `application/octet-stream` responses can still be
 * accepted. Callers must pass at least 12 bytes when they want the WebP check
 * to have a chance.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Number of leading bytes `sniffImageMime` needs to make a decision. */
export const MIME_SNIFF_BYTES = 16;

/**
 * Resolve a blob's mime type, or `null` when it is not a supported image.
 *
 * The declared value wins, exactly like the download path: renaming a `.txt`
 * to `.png` still fails, because the declared type is only trusted when it is
 * on the whitelist — and a text file never declares `image/png`.
 */
export async function resolveImageMime(blob: Blob): Promise<string | null> {
  if (DECLARED_IMAGE_MIME.test(blob.type)) return blob.type;
  const head = new Uint8Array(await blob.slice(0, MIME_SNIFF_BYTES).arrayBuffer());
  return sniffImageMime(head);
}
