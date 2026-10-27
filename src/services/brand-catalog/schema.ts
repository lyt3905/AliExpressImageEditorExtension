/**
 * The remote brand catalog: shape, validation, and URL resolution.
 *
 * The catalog is a JSON manifest plus one image per brand, kept in the project's
 * own repository under `catalog/`. A commit is the whole "deploy": the extension
 * reads `main` over HTTPS, so adding a brand needs no new release and no version
 * bump (see AGENTS.md — only `src/` requires that).
 *
 * Everything that arrives over the network is treated as untrusted input. The
 * rules in here are what keep a typo (or a compromised repo) from turning into
 * "some URL I control gets fetched and written into IndexedDB":
 *
 * - `brands[].logo.file` must be a relative `logos/<slug>.<png|jpg|webp>` path.
 *   No absolute URLs, no `..`, no other extensions.
 * - the resolved URL must stay on the catalog's own origin and under the
 *   catalog directory (checked on the parsed URL, not on the string).
 * - the manifest has a byte ceiling and a brand ceiling.
 *
 * Nothing here touches the network or storage: this module is pure so the rules
 * are unit-testable in plain node.
 */

import {
  BRAND_BLOB_PREFIX,
  BRAND_CATALOG_LOGO_PATTERN,
  BRAND_CATALOG_MAX_BRANDS,
  BRAND_CATALOG_MAX_BYTES,
  BRAND_CATALOG_SLUG_PATTERN,
} from '../../shared/constants';

export type CatalogErrorCode = 'shape' | 'size' | 'count' | 'duplicate' | 'url';

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

export interface CatalogLogo {
  /** Relative path inside the catalog directory, e.g. `logos/morph-toys.png`. */
  file: string;
  /** Optional SHA-256 of the image bytes; verified after download when present. */
  sha256?: string;
}

export interface CatalogBrand {
  /** Stable slug — the primary key. Renaming it creates a new brand. */
  id: string;
  name: string;
  aliases: string[];
  keywords: string[];
  logo: CatalogLogo;
  /**
   * Content fingerprint. Anything that differs from the locally stored one makes
   * the sync re-download this brand. Defaults to the sha256, else to the catalog
   * version — so either bumping `version` or adding a `sha256` is enough.
   */
  rev: string;
}

export interface BrandCatalog {
  /** Monotonic integer. A sync compares it with the last synced one and stops there. */
  version: number;
  updatedAt?: string;
  brands: CatalogBrand[];
}

const MAX_NAME_LENGTH = 120;
const MAX_TERM_LENGTH = 60;
const MAX_TERMS = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Trimmed, de-duplicated, bounded list of title terms. */
function readTerms(value: unknown, field: string, index: number): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CatalogError('shape', `第 ${index + 1} 个品牌的 ${field} 不是数组`);
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new CatalogError('shape', `第 ${index + 1} 个品牌的 ${field} 里有非字符串项`);
    }
    const term = entry.trim();
    if (!term) continue;
    if (term.length > MAX_TERM_LENGTH) {
      throw new CatalogError(
        'shape',
        `第 ${index + 1} 个品牌的 ${field} 有一项超过 ${MAX_TERM_LENGTH} 字`,
      );
    }
    seen.add(term);
    if (seen.size > MAX_TERMS) {
      throw new CatalogError('shape', `第 ${index + 1} 个品牌的 ${field} 超过 ${MAX_TERMS} 项`);
    }
  }
  return [...seen];
}

function readBrand(value: unknown, index: number, version: number): CatalogBrand {
  if (!isRecord(value)) {
    throw new CatalogError('shape', `第 ${index + 1} 个品牌不是对象`);
  }
  const id = typeof value.id === 'string' ? value.id.trim() : '';
  if (!BRAND_CATALOG_SLUG_PATTERN.test(id)) {
    throw new CatalogError(
      'shape',
      `第 ${index + 1} 个品牌的 id 不合法（只允许小写字母、数字、连字符）`,
    );
  }
  const name = typeof value.name === 'string' ? value.name.trim() : '';
  if (!name || name.length > MAX_NAME_LENGTH) {
    throw new CatalogError('shape', `品牌「${id}」的名称缺失或超过 ${MAX_NAME_LENGTH} 字`);
  }

  const logo = value.logo;
  if (!isRecord(logo)) {
    throw new CatalogError('shape', `品牌「${id}」缺少 logo 字段`);
  }
  const file = typeof logo.file === 'string' ? logo.file.trim() : '';
  if (!BRAND_CATALOG_LOGO_PATTERN.test(file)) {
    throw new CatalogError(
      'shape',
      `品牌「${id}」的 logo.file 必须是 logos/<名字>.png|jpg|webp，不能是绝对地址或上一级路径`,
    );
  }
  let sha256: string | undefined;
  if (logo.sha256 !== undefined) {
    const raw = typeof logo.sha256 === 'string' ? logo.sha256.trim().toLowerCase() : '';
    if (!/^[a-f0-9]{64}$/.test(raw)) {
      throw new CatalogError('shape', `品牌「${id}」的 logo.sha256 不是 64 位十六进制`);
    }
    sha256 = raw;
  }

  const providedRev = typeof value.rev === 'string' ? value.rev.trim() : '';
  const rev = providedRev || sha256 || `v${version}`;

  return {
    id,
    name,
    aliases: readTerms(value.aliases, 'aliases', index),
    keywords: readTerms(value.keywords, 'keywords', index),
    logo: sha256 ? { file, sha256 } : { file },
    rev,
  };
}

/**
 * Parse and validate a catalog manifest.
 *
 * Throws `CatalogError` — the caller keeps whatever it had before, which is the
 * whole reason the registry is the source of truth and the catalog is only input.
 */
export function parseBrandCatalog(raw: string): BrandCatalog {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new CatalogError('shape', '品牌目录为空');
  }
  if (raw.length > BRAND_CATALOG_MAX_BYTES) {
    const limit = Math.round(BRAND_CATALOG_MAX_BYTES / 1024);
    throw new CatalogError('size', `品牌目录超过 ${limit}KB 上限`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CatalogError('shape', '品牌目录不是合法 JSON');
  }
  if (!isRecord(value)) {
    throw new CatalogError('shape', '品牌目录的根节点必须是对象');
  }
  const version = value.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new CatalogError('shape', '品牌目录缺少递增的整数 version');
  }
  if (!Array.isArray(value.brands)) {
    throw new CatalogError('shape', '品牌目录缺少 brands 数组');
  }
  if (value.brands.length > BRAND_CATALOG_MAX_BRANDS) {
    throw new CatalogError('count', `品牌数量超过 ${BRAND_CATALOG_MAX_BRANDS} 条上限`);
  }

  const brands: CatalogBrand[] = [];
  const seen = new Set<string>();
  value.brands.forEach((entry, index) => {
    const brand = readBrand(entry, index, version);
    if (seen.has(brand.id)) {
      throw new CatalogError('duplicate', `品牌 id 重复：${brand.id}`);
    }
    seen.add(brand.id);
    brands.push(brand);
  });

  const updatedAt = typeof value.updatedAt === 'string' ? value.updatedAt.trim() : undefined;
  return updatedAt ? { version, updatedAt, brands } : { version, brands };
}

/**
 * Absolute URL of the manifest, from a catalog directory URL.
 *
 * Only HTTPS is accepted, with a loopback exception so a developer can serve the
 * catalog from their own machine while testing.
 */
export function resolveCatalogUrl(baseUrl: string): string {
  const base = parseCatalogBase(baseUrl);
  return new URL('brands.json', base).toString();
}

/**
 * Absolute URL of one logo.
 *
 * The escape check runs on the **parsed** URL: `new URL('../../x.png', base)`
 * would silently walk out of the directory, so the result must still start with
 * the catalog directory's pathname.
 */
export function resolveLogoUrl(baseUrl: string, file: string): string {
  const base = parseCatalogBase(baseUrl);
  if (!BRAND_CATALOG_LOGO_PATTERN.test(file)) {
    throw new CatalogError('url', `Logo 路径不合法：${file}`);
  }
  const resolved = new URL(file, base);
  if (resolved.origin !== base.origin || !resolved.pathname.startsWith(base.pathname)) {
    throw new CatalogError('url', `Logo 路径越界：${file}`);
  }
  return resolved.toString();
}

function parseCatalogBase(baseUrl: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new CatalogError('url', `品牌目录地址不是合法 URL：${baseUrl}`);
  }
  const loopback = base.hostname === '127.0.0.1' || base.hostname === 'localhost';
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new CatalogError('url', '品牌目录必须走 HTTPS（本机调试可用 127.0.0.1）');
  }
  // Normalise to a directory: `https://host/catalog` and `https://host/catalog/`
  // must resolve the same way, otherwise the logo prefix check compares against
  // the wrong pathname.
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  base.search = '';
  base.hash = '';
  return base;
}

/**
 * Registry ids for a catalog slug.
 *
 * Both are derived from the slug and nothing else, so a re-sync replaces the
 * blob in place: layers already sitting on a canvas keep pointing at the same
 * `material-brand-<id>` and never lose their logo.
 */
export function remoteBrandId(slug: string): string {
  return `remote-${slug}`;
}

export function remoteLogoBlobId(slug: string): string {
  return `${BRAND_BLOB_PREFIX}remote-${slug}`;
}
