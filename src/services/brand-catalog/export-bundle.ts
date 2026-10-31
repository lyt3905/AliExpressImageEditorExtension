/**
 * Export the brand registry as a `catalog/`-shaped bundle.
 *
 * The problem this solves: a hand-uploaded logo lives in one browser profile
 * (`chrome.storage.local` + IndexedDB) and is deliberately never touched by the
 * catalog sync — only entries with `source: 'remote'` can be updated or removed by
 * it. So a brand uploaded on one machine is invisible on the next one, forever.
 *
 * Rather than teaching the extension to upload somewhere (there is no server in the
 * loop, and the user explicitly wanted it that way), this exports the whole registry
 * in exactly the layout the sync already knows how to read:
 *
 * ```
 * brands.json
 * logos/<slug>.png
 * ```
 *
 * Drop that on any HTTPS host, put its URL in 「自填目录地址」, and every client that
 * syncs gets the hand-uploaded brands too. Same schema, same code path, no new
 * endpoint — the catalog directory is the interchange format.
 *
 * Output rules that matter for the receiving side (`brand-catalog/schema.ts`):
 *   - `logo.file` must match `logos/[a-z0-9][a-z0-9._-]*\.(png|jpe?g|webp)`;
 *   - `id` must match `[a-z0-9][a-z0-9-]{0,63}` — renaming it creates a new brand,
 *     which is why remote brands keep their existing `slug`;
 *   - `sha256` makes a logo swap re-download even without bumping `version`;
 *   - `version` must be an integer ≥ 1 and only ever move forward.
 */

import { BRAND_CATALOG_LOGO_PATTERN, BRAND_CATALOG_SLUG_PATTERN } from '../../shared/constants';
import type { BrandMeta } from '../../shared/types';
import { createZip, type ZipEntry } from '../zip';

/** Default manifest version: seconds since the epoch, so exports keep moving forward. */
function defaultVersion(now: Date): number {
  return Math.max(1, Math.floor(now.getTime() / 1000));
}

function isoDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Hex SHA-256 of the image bytes — the `rev` the receiving side compares. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', view);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Image extension from the bytes themselves.
 *
 * Reading magic bytes instead of `Blob.type` on purpose: a blob that went through
 * IndexedDB (or came from the clipboard) can arrive with an empty or wrong type, and
 * a wrong extension breaks the `logo.file` pattern on the receiving side.
 */
export function imageExtension(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'webp';
  }
  return null;
}

/**
 * Slug for a brand that has none yet (hand-uploaded entries).
 *
 * Only ASCII lowercase, digits and `-` survive — the pattern the catalog enforces.
 * A Chinese-only name leaves nothing behind, so those fall back to a stable
 * `brand-<id fragment>` rather than `brand-1`, `brand-2`: the fallback should not
 * depend on the order of the list, or re-exporting after adding a brand would
 * silently rename existing ones (and renaming an id = a new brand downstream).
 */
export function brandSlug(name: string, fallbackSeed: string): string {
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  if (BRAND_CATALOG_SLUG_PATTERN.test(ascii)) return ascii;

  // The seed is a registry id like `brand-<time36>-<rand>`; its last segment is the
  // random part, which is both readable (`brand-abc123`) and — unlike a positional
  // number — never shifts when another brand is added above it.
  const tail = fallbackSeed.split('-').pop() ?? '';
  const seed = tail
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(-12);
  const candidate = `brand-${seed || 'x'}`;
  return BRAND_CATALOG_SLUG_PATTERN.test(candidate) ? candidate : `brand-${Date.now().toString(36)}`;
}

/** Make room for `slug` in `taken`, appending `-2`, `-3`, … as needed. */
function uniqueSlug(slug: string, taken: Set<string>): string {
  if (!taken.has(slug)) {
    taken.add(slug);
    return slug;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const trimmed = slug.slice(0, Math.max(1, 60 - String(suffix).length));
    const next = `${trimmed}-${suffix}`;
    if (!taken.has(next) && BRAND_CATALOG_SLUG_PATTERN.test(next)) {
      taken.add(next);
      return next;
    }
  }
  throw new Error(`无法为「${slug}」找到唯一的目录 id`);
}

export interface BundleBrand {
  id: string;
  name: string;
  keywords: readonly string[];
  file: string;
  sha256: string;
}

export interface CatalogBundleOptions {
  /** Load the logo blob for one brand. Missing/empty blob = skipped, not exported. */
  loadLogo: (brand: BrandMeta) => Promise<Blob | null>;
  /** Manifest version. Defaults to seconds since the epoch. */
  version?: number;
  now?: Date;
}

export interface CatalogBundle {
  /** The zip: `brands.json` + `logos/*`. */
  blob: Blob;
  fileName: string;
  /** The manifest exactly as written into the archive (2-space JSON + newline). */
  manifest: string;
  /** What went into `brands.json`, in output order. */
  brands: BundleBrand[];
  /** Names of brands that were not exported because their logo was gone. */
  skipped: string[];
}

/**
 * Build the bundle.
 *
 * A brand without a readable logo is **skipped and reported**, never exported with a
 * placeholder: a catalog entry pointing at a file that is not in the archive would
 * fail on the receiving side at download time, and the error would show up as
 * "sync failed" on a machine that has nothing wrong with it.
 */
export async function buildCatalogBundle(
  brands: readonly BrandMeta[],
  options: CatalogBundleOptions,
): Promise<CatalogBundle> {
  const now = options.now ?? new Date();
  const skipped: string[] = [];
  const taken = new Set<string>();
  const entries: ZipEntry[] = [];
  const exported: BundleBrand[] = [];

  // Sort by id so two exports of the same registry produce the same manifest order
  // (and therefore diff cleanly if the user keeps it in a repo).
  const ordered = [...brands].sort((left, right) => left.id.localeCompare(right.id));

  for (const brand of ordered) {
    let blob: Blob | null = null;
    try {
      blob = await options.loadLogo(brand);
    } catch {
      blob = null;
    }
    if (!blob || blob.size === 0) {
      skipped.push(brand.name);
      continue;
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const extension = imageExtension(bytes);
    if (!extension) {
      skipped.push(brand.name);
      continue;
    }

    // Remote brands already own a stable slug; renaming it would create a new brand
    // on every client that already synced. Local ones get one derived from the name.
    const preferred = brand.slug && BRAND_CATALOG_SLUG_PATTERN.test(brand.slug)
      ? brand.slug
      : brandSlug(brand.name, brand.id);
    const id = uniqueSlug(preferred, taken);
    const file = `logos/${id}.${extension}`;
    if (!BRAND_CATALOG_LOGO_PATTERN.test(file)) {
      throw new Error(`生成的 logo 路径不合法：${file}`);
    }

    entries.push({ path: file, bytes, date: now });
    exported.push({
      id,
      name: brand.name,
      keywords: [...brand.keywords],
      file,
      sha256: await sha256Hex(bytes),
    });
  }

  if (exported.length === 0) {
    throw new Error('没有任何品牌可以导出（Logo 都读不到）');
  }

  const version = options.version ?? defaultVersion(now);
  const manifest = {
    version,
    updatedAt: isoDate(now),
    brands: exported.map((brand) => ({
      id: brand.id,
      name: brand.name,
      keywords: brand.keywords,
      logo: { file: brand.file, sha256: brand.sha256 },
    })),
  };
  const json = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
  entries.unshift({ path: 'brands.json', bytes: json, date: now });

  return {
    blob: createZip(entries),
    fileName: `brand-catalog-${isoDate(now)}.zip`,
    manifest: `${JSON.stringify(manifest, null, 2)}\n`,
    brands: exported,
    skipped,
  };
}
