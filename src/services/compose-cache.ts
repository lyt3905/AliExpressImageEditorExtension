/**
 * Cache for "生成主图", so the same product is not generated from scratch twice.
 *
 * ## Why this exists
 *
 * Everything the editor produces is scoped to one session: the session id is new
 * on every open, the source blobs are copied under session-scoped ids, and the
 * canvas is restored from `aiee:doc:<sessionId>`. That is the right default — a
 * reload must not resurrect somebody else's canvas — but it also means the two
 * expensive steps are paid again on every single visit:
 *
 *   - 抠图 costs an upload + a server round trip (tens of seconds per image);
 *   - AI 识别素材角色 costs tokens and 4–10 s of waiting.
 *
 * Neither of them depends on the session. A cut-out is a pure function of the
 * source image, and the hero/box decision is a pure function of the material set.
 * So both are cached against the SOURCE, not against the session:
 *
 *   - cut-out      keyed by source-image identity  (a CDN url, or size+bytes for
 *                  an uploaded file) → cached blob id, so a new session adopts
 *                  the blob instead of uploading again;
 *   - AI binding   keyed by the material set + the vision model, stored in terms
 *                  of IMAGE IDENTITY (never material ids, they are session-scoped)
 *                  and mapped back to this session's materials on read;
 *   - finished PNG keyed by materials + template + hero/box, so the 800×800 that
 *                  was already rendered can be downloaded again without touching
 *                  the canvas or the server.
 *
 * ## Invalidation
 *
 * The chosen rule is "素材变了就失效": the key of every entry contains the
 * identity of every source image involved, so adding, removing or replacing a
 * product photo is enough to miss the cache — no timestamps, no TTL, nothing to
 * explain to a seller. Two consequences worth knowing:
 *
 *   - a re-ordered shot list does NOT miss (identities are sorted);
 *   - a product whose photos were edited in place on the AliExpress side does
 *     keep its old cut-out as long as the CDN url is unchanged. That is the same
 *     assumption the image downloader already makes, and the fix is a manual
 *     「清除缓存」.
 *
 * ## What this module deliberately does not do
 *
 * No IndexedDB schema change. Blobs go into the existing `blobs` store under
 * deterministic ids and the index lives in `chrome.storage.local`, which keeps
 * `DB_VERSION` at 1 and makes the whole cache removable by deleting one key.
 */

import {
  COMPOSE_CACHE_MAX_BINDINGS,
  COMPOSE_CACHE_MAX_CUTOUTS,
  COMPOSE_CACHE_MAX_RESULTS,
  COMPOSE_CACHE_VERSION,
  COMPOSE_RESULT_PREFIX,
  CUTOUT_CACHE_PREFIX,
  STORAGE_KEYS,
} from '../shared/constants';
import { deleteBlob, getBlob, putBlob } from './indexed-db';

/** The parts of a session image that can identify it across sessions. */
export interface CacheableImage {
  /** Product-page image url. Empty for files uploaded with the file picker. */
  url?: string;
  label?: string;
  width?: number;
  height?: number;
  /** Byte size of the original blob — what identifies an uploaded file. */
  bytes?: number;
  /** Last resort: the session-scoped blob id (never matches across sessions). */
  blobId?: string;
}

/**
 * A stable name for one source image.
 *
 * The url is the good case: AliExpress CDN urls are content addresses, so the
 * same photo keeps its url between visits. Uploaded files have no url at all —
 * `''`, see `upload-images.ts` — so they are identified by name + byte size +
 * pixel size, which is stable for "the same file picked again" and different for
 * anything else. When even that is unavailable the blob id is used, which
 * effectively disables reuse for that image, and that is the safe direction.
 */
export function imageIdentity(image: CacheableImage): string {
  const url = (image.url ?? '').trim();
  if (url) return `url:${url}`;

  const bytes = Number.isFinite(image.bytes) ? Math.round(image.bytes as number) : 0;
  if (bytes > 0) {
    const label = (image.label ?? '').trim();
    const width = Math.round(image.width ?? 0);
    const height = Math.round(image.height ?? 0);
    return `local:${label}|${bytes}|${width}x${height}`;
  }

  return `blob:${image.blobId ?? ''}`;
}

/** FNV-1a, 32 bit, hex. Short keys because they end up in blob ids and log lines. */
export function hashKey(parts: ReadonlyArray<string | number | null | undefined>): string {
  const text = parts.map((part) => (part === null || part === undefined ? '' : String(part))).join('\u0000');
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))].sort();
}

/** Deterministic blob id, so two sessions share one cut-out instead of copying it. */
export function cutoutBlobIdFor(identity: string): string {
  return `${CUTOUT_CACHE_PREFIX}${hashKey([identity])}`;
}

/** Deterministic blob id for one finished composite. */
export function resultBlobIdFor(key: string): string {
  return `${COMPOSE_RESULT_PREFIX}${key}`;
}

/**
 * Key of an AI binding: which material set was judged, by which model.
 *
 * The model is part of the key on purpose — swapping the vision model is exactly
 * the case where the previous answer should not be reused.
 */
export function bindingKeyFor(input: {
  productCode?: string | null;
  identities: readonly string[];
  model?: string;
  baseUrl?: string;
}): string {
  return hashKey([
    'binding',
    input.productCode ?? '',
    input.model ?? '',
    input.baseUrl ?? '',
    ...sortedUnique(input.identities),
  ]);
}

/** Key of a finished composite: the material set plus everything that shapes it. */
export function resultKeyFor(input: {
  productCode?: string | null;
  identities: readonly string[];
  templateKey: string;
  heroIdentity?: string | null;
  boxIdentity?: string | null;
}): string {
  return hashKey([
    'result',
    input.productCode ?? '',
    input.templateKey,
    input.heroIdentity ?? '',
    input.boxIdentity ?? '',
    ...sortedUnique(input.identities),
  ]);
}

// ---------------------------------------------------------------- state

export interface CachedCutout {
  /** Blob id in the shared `blobs` store (deterministic, see `cutoutBlobIdFor`). */
  blobId: string;
  width: number;
  height: number;
  at: number;
}

/** What the AI said about one material set, stored in image identities. */
export interface CachedBinding {
  /** Identity of the hero image, or '' when the answer named none. */
  hero: string;
  box: string | null;
  confidence: number;
  reason: string;
  at: number;
}

export interface CachedResult {
  blobId: string;
  at: number;
}

export interface ComposeCacheState {
  version: number;
  cutouts: Record<string, CachedCutout>;
  bindings: Record<string, CachedBinding>;
  results: Record<string, CachedResult>;
}

export const EMPTY_COMPOSE_CACHE: ComposeCacheState = {
  version: COMPOSE_CACHE_VERSION,
  cutouts: {},
  bindings: {},
  results: {},
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

/** Keep only the newest `max` entries of one section (oldest `at` goes first). */
export function pruneSection<T extends { at: number }>(section: Record<string, T>, max: number): Record<string, T> {
  const entries = Object.entries(section);
  if (entries.length <= max) return section;
  entries.sort((left, right) => right[1].at - left[1].at);
  return Object.fromEntries(entries.slice(0, Math.max(0, max)));
}

export function pruneComposeCache(state: ComposeCacheState): ComposeCacheState {
  return {
    version: COMPOSE_CACHE_VERSION,
    cutouts: pruneSection(state.cutouts, COMPOSE_CACHE_MAX_CUTOUTS),
    bindings: pruneSection(state.bindings, COMPOSE_CACHE_MAX_BINDINGS),
    results: pruneSection(state.results, COMPOSE_CACHE_MAX_RESULTS),
  };
}

/**
 * Turn whatever is in storage into a usable state.
 *
 * A cache is an optimization: a hand-edited or half-written value must degrade to
 * "no cache", never to an exception on editor startup.
 */
export function parseComposeCacheState(raw: unknown): ComposeCacheState {
  if (!isRecord(raw)) return EMPTY_COMPOSE_CACHE;

  const cutouts: Record<string, CachedCutout> = {};
  if (isRecord(raw.cutouts)) {
    for (const [key, value] of Object.entries(raw.cutouts)) {
      if (!key || !isRecord(value)) continue;
      const blobId = str(value.blobId);
      if (!blobId) continue;
      cutouts[key] = { blobId, width: num(value.width), height: num(value.height), at: num(value.at) };
    }
  }

  const bindings: Record<string, CachedBinding> = {};
  if (isRecord(raw.bindings)) {
    for (const [key, value] of Object.entries(raw.bindings)) {
      if (!key || !isRecord(value)) continue;
      const hero = str(value.hero);
      const box = typeof value.box === 'string' ? value.box : null;
      if (!hero && !box) continue;
      bindings[key] = {
        hero,
        box,
        confidence: num(value.confidence),
        reason: str(value.reason),
        at: num(value.at),
      };
    }
  }

  const results: Record<string, CachedResult> = {};
  if (isRecord(raw.results)) {
    for (const [key, value] of Object.entries(raw.results)) {
      if (!key || !isRecord(value)) continue;
      const blobId = str(value.blobId);
      if (!blobId) continue;
      results[key] = { blobId, at: num(value.at) };
    }
  }

  return pruneComposeCache({ version: COMPOSE_CACHE_VERSION, cutouts, bindings, results });
}

// ---------------------------------------------------------------- storage port

/**
 * Everything this module touches outside of itself.
 *
 * Injected so the logic is unit-testable in plain Node: the repo has no fake
 * IndexedDB in the test setup, and a cache is not worth adding one for.
 */
export interface ComposeCachePorts {
  readLocal(key: string): Promise<unknown>;
  writeLocal(key: string, value: unknown): Promise<void>;
  putBlob(id: string, blob: Blob): Promise<void>;
  getBlob(id: string): Promise<Blob | null>;
  deleteBlob(id: string): Promise<void>;
  now(): number;
}

export function browserComposeCachePorts(): ComposeCachePorts {
  return {
    async readLocal(key) {
      const stored = await chrome.storage.local.get(key);
      return stored?.[key];
    },
    async writeLocal(key, value) {
      await chrome.storage.local.set({ [key]: value });
    },
    putBlob: (id, blob) => putBlob(id, blob).then(() => undefined),
    getBlob: (id) => getBlob(id),
    deleteBlob: (id) => deleteBlob(id),
    now: () => Date.now(),
  };
}

export interface ComposeCacheStats {
  cutouts: number;
  bindings: number;
  results: number;
}

export interface ComposeCache {
  read(): Promise<ComposeCacheState>;
  getCutout(identity: string): Promise<CachedCutout | null>;
  /** True when the cached blob is still readable (the index can outlive the blob). */
  hasCutoutBlob(entry: CachedCutout): Promise<boolean>;
  putCutout(identity: string, blob: Blob, size: { width: number; height: number }): Promise<CachedCutout>;
  getBinding(key: string): Promise<CachedBinding | null>;
  putBinding(key: string, binding: Omit<CachedBinding, 'at'>): Promise<void>;
  getResult(key: string): Promise<CachedResult | null>;
  readResultBlob(key: string): Promise<Blob | null>;
  putResult(key: string, blob: Blob): Promise<CachedResult>;
  stats(): Promise<ComposeCacheStats>;
  /** Forget every index entry and delete the blobs they point at. */
  clear(): Promise<number>;
}

function modify(
  state: ComposeCacheState,
  change: (draft: ComposeCacheState) => void,
): ComposeCacheState {
  const draft: ComposeCacheState = {
    version: COMPOSE_CACHE_VERSION,
    cutouts: { ...state.cutouts },
    bindings: { ...state.bindings },
    results: { ...state.results },
  };
  change(draft);
  return pruneComposeCache(draft);
}

export function createComposeCache(ports: ComposeCachePorts = browserComposeCachePorts()): ComposeCache {
  const read = async (): Promise<ComposeCacheState> => {
    try {
      return parseComposeCacheState(await ports.readLocal(STORAGE_KEYS.composeCache));
    } catch {
      return EMPTY_COMPOSE_CACHE;
    }
  };

  const write = async (state: ComposeCacheState): Promise<void> => {
    try {
      await ports.writeLocal(STORAGE_KEYS.composeCache, state);
    } catch {
      // A cache that cannot be written is still a working editor.
    }
  };

  const getCutout = async (identity: string): Promise<CachedCutout | null> => {
    if (!identity) return null;
    const state = await read();
    return state.cutouts[identity] ?? null;
  };

  const putCutout = async (
    identity: string,
    blob: Blob,
    size: { width: number; height: number },
  ): Promise<CachedCutout> => {
    const blobId = cutoutBlobIdFor(identity);
    await ports.putBlob(blobId, blob);
    const entry: CachedCutout = {
      blobId,
      width: Math.round(size.width),
      height: Math.round(size.height),
      at: ports.now(),
    };
    const state = await read();
    await write(modify(state, (draft) => {
      draft.cutouts[identity] = entry;
    }));
    return entry;
  };

  const getBinding = async (key: string): Promise<CachedBinding | null> => {
    if (!key) return null;
    const state = await read();
    return state.bindings[key] ?? null;
  };

  const getResult = async (key: string): Promise<CachedResult | null> => {
    if (!key) return null;
    const state = await read();
    return state.results[key] ?? null;
  };

  return {
    read,
    getCutout,
    async hasCutoutBlob(entry) {
      try {
        return (await ports.getBlob(entry.blobId)) !== null;
      } catch {
        return false;
      }
    },
    putCutout,
    getBinding,
    async putBinding(key, binding) {
      if (!key) return;
      const state = await read();
      await write(modify(state, (draft) => {
        draft.bindings[key] = { ...binding, at: ports.now() };
      }));
    },
    getResult,
    async readResultBlob(key) {
      const entry = await getResult(key);
      if (!entry) return null;
      try {
        return await ports.getBlob(entry.blobId);
      } catch {
        return null;
      }
    },
    async putResult(key, blob) {
      const blobId = resultBlobIdFor(key);
      await ports.putBlob(blobId, blob);
      const entry: CachedResult = { blobId, at: ports.now() };
      const state = await read();
      await write(modify(state, (draft) => {
        draft.results[key] = entry;
      }));
      return entry;
    },
    async stats() {
      const state = await read();
      return {
        cutouts: Object.keys(state.cutouts).length,
        bindings: Object.keys(state.bindings).length,
        results: Object.keys(state.results).length,
      };
    },
    async clear() {
      const state = await read();
      const blobIds = [
        ...Object.values(state.cutouts).map((entry) => entry.blobId),
        ...Object.values(state.results).map((entry) => entry.blobId),
      ];
      let removed = 0;
      for (const blobId of blobIds) {
        try {
          await ports.deleteBlob(blobId);
          removed += 1;
        } catch {
          // Already gone is the same outcome as removed.
        }
      }
      await write(EMPTY_COMPOSE_CACHE);
      return removed;
    },
  };
}
