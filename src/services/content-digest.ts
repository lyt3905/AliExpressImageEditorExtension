/**
 * Content digests for local uploads.
 *
 * The compose cache names an uploaded picture by what it *is*, not by what it is
 * called: file name + byte size + pixel size is not unique (two different
 * 800×800 PNGs can both be 4320 bytes — a 10.22.0 review built exactly that pair
 * and got product A's cut-out back for product B). A SHA-256 over the original
 * bytes is the cheapest identity that cannot collide in practice.
 *
 * Failures are swallowed on purpose: a browser without `crypto.subtle` (or a
 * blob that vanished) must degrade to the old name-based identity, not break the
 * upload.
 */

/** SHA-256 of the blob, lowercase hex. Resolves to `''` when unavailable. */
export async function blobDigest(blob: Blob | null | undefined): Promise<string> {
  if (!blob || blob.size === 0) return '';
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return '';
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const hash = await subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  } catch {
    return '';
  }
}

/** True when `value` looks like a digest produced by `blobDigest()` above. */
export function isContentDigest(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32,64}$/.test(value.trim().toLowerCase());
}
