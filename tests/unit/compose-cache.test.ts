import { describe, expect, it } from 'vitest';
import {
  EMPTY_COMPOSE_CACHE,
  bindingKeyFor,
  createComposeCache,
  cutoutBlobIdFor,
  hashKey,
  imageIdentity,
  parseComposeCacheState,
  pruneSection,
  resultBlobIdFor,
  resultKeyFor,
  type ComposeCachePorts,
} from '../../src/services/compose-cache';
import {
  COMPOSE_CACHE_MAX_CUTOUTS,
  COMPOSE_RESULT_PREFIX,
  CUTOUT_CACHE_PREFIX,
  STORAGE_KEYS,
} from '../../src/shared/constants';

/**
 * In-memory stand-in for `chrome.storage.local` + the IndexedDB blob store.
 *
 * The module takes its storage as a port precisely so the whole cache can be
 * exercised in plain Node — the repo has no fake IndexedDB, and a cache is not
 * worth introducing one.
 */
function fakePorts(clock = { now: 1000 }) {
  const values = new Map<string, unknown>();
  const blobs = new Map<string, Blob>();
  const deleted: string[] = [];
  const ports: ComposeCachePorts = {
    async readLocal(key) {
      return values.get(key);
    },
    async writeLocal(key, value) {
      values.set(key, value);
    },
    async putBlob(id, blob) {
      blobs.set(id, blob);
    },
    async getBlob(id) {
      return blobs.get(id) ?? null;
    },
    async deleteBlob(id) {
      blobs.delete(id);
      deleted.push(id);
    },
    now: () => clock.now,
  };
  return { ports, values, blobs, deleted, clock };
}

const png = (name: string): Blob => new Blob([name], { type: 'image/png' });

describe('imageIdentity', () => {
  it('uses the source url when there is one', () => {
    expect(imageIdentity({ url: 'https://ae01.alicdn.com/a.jpg', bytes: 12 })).toBe(
      'url:https://ae01.alicdn.com/a.jpg',
    );
  });

  it('falls back to label + size + pixels for an uploaded file', () => {
    // Uploads carry `url: ''` on purpose (see services/upload-images.ts).
    expect(
      imageIdentity({ url: '', label: '正面.png', bytes: 2048, width: 800, height: 600 }),
    ).toBe('local:正面.png|2048|800x600');
  });

  it('treats a whitespace url as absent', () => {
    expect(imageIdentity({ url: '   ', bytes: 1, width: 2, height: 3 })).toBe('local:|1|2x3');
  });

  it('uses the blob id only when nothing else is known', () => {
    // Degrades to "no reuse across sessions", which is the safe direction.
    expect(imageIdentity({ blobId: 'image-3' })).toBe('blob:image-3');
    expect(imageIdentity({})).toBe('blob:');
  });

  it('does not round bytes into nothing', () => {
    expect(imageIdentity({ bytes: 0.4, width: 1, height: 1 })).toBe('blob:');
  });
});

describe('hashKey', () => {
  it('is stable and shaped like a short hex id', () => {
    expect(hashKey(['a', 'b'])).toMatch(/^[0-9a-f]{8}$/);
    expect(hashKey(['a', 'b'])).toBe(hashKey(['a', 'b']));
  });

  it('separates different inputs, including the boundary between them', () => {
    expect(hashKey(['ab', 'c'])).not.toBe(hashKey(['a', 'bc']));
    expect(hashKey([1, 2])).not.toBe(hashKey([2, 1]));
  });

  it('treats null and undefined as empty', () => {
    expect(hashKey(['a', null, 'b'])).toBe(hashKey(['a', undefined, 'b']));
  });
});

describe('cache keys', () => {
  it('gives a cut-out blob a deterministic id per source image', () => {
    const id = cutoutBlobIdFor('url:https://x/1.jpg');
    expect(id).toBe(`${CUTOUT_CACHE_PREFIX}${hashKey(['url:https://x/1.jpg'])}`);
    expect(cutoutBlobIdFor('url:https://x/1.jpg')).toBe(id);
    expect(cutoutBlobIdFor('url:https://x/2.jpg')).not.toBe(id);
  });

  it('names result blobs by key', () => {
    expect(resultBlobIdFor('abc123')).toBe(`${COMPOSE_RESULT_PREFIX}abc123`);
  });

  it('never keys on a blob: url — those are per-tab object urls', () => {
    // Same file, two sessions: the object url differs, the identity must not.
    const first = imageIdentity({ url: 'blob:chrome-extension://abc/1', label: 'a.png', bytes: 100, width: 10, height: 20 });
    const second = imageIdentity({ url: 'blob:chrome-extension://abc/2', label: 'a.png', bytes: 100, width: 10, height: 20 });
    expect(first).toBe(second);
    expect(first).toBe('local:a.png|100|10x20');
  });

  it('ignores material order and the set when the product code is known', () => {
    const base = { productCode: 'P1', model: 'm' };
    expect(bindingKeyFor({ ...base, identities: ['url:a', 'url:b'] })).toBe(
      bindingKeyFor({ ...base, identities: ['url:b', 'url:a'] }),
    );
    // One photo more (a failed cut-out yesterday, an extra photo today) is the
    // same listing: the answer the model gave about it still stands.
    expect(bindingKeyFor({ ...base, identities: ['url:a'] })).toBe(
      bindingKeyFor({ ...base, identities: ['url:a', 'url:b'] }),
    );
    // A different listing is not.
    expect(bindingKeyFor({ ...base, productCode: 'P2', identities: ['url:a'] })).not.toBe(
      bindingKeyFor({ ...base, productCode: 'P1', identities: ['url:a'] }),
    );
  });

  it('falls back to the photo set when there is no product code', () => {
    const base = { productCode: null, identities: ['url:a'] };
    expect(bindingKeyFor({ ...base, identities: ['url:a', 'url:b'] })).not.toBe(
      bindingKeyFor(base),
    );
    expect(bindingKeyFor({ ...base, identities: ['url:a', 'url:a'] })).toBe(bindingKeyFor(base));
  });

  it('changes with the vision model — a new model must not reuse the old answer', () => {
    const identities = ['url:a'];
    expect(bindingKeyFor({ identities, model: 'gpt-a' })).not.toBe(
      bindingKeyFor({ identities, model: 'gpt-b' }),
    );
  });

  it('changes the result key when the template, the hero or the box changes', () => {
    const base = { productCode: 'P1', templateKey: 't@1', heroIdentity: 'url:a', boxIdentity: 'url:b' };
    expect(resultKeyFor({ ...base, templateKey: 't@2' })).not.toBe(resultKeyFor(base));
    expect(resultKeyFor({ ...base, heroIdentity: 'url:b' })).not.toBe(resultKeyFor(base));
    expect(resultKeyFor({ ...base, boxIdentity: null })).not.toBe(resultKeyFor(base));
    expect(resultKeyFor({ ...base, productCode: 'P2' })).not.toBe(resultKeyFor(base));
  });
});

describe('state parsing', () => {
  it('degrades to an empty cache instead of throwing', () => {
    for (const raw of [null, undefined, 42, 'x', [], {}, { cutouts: 'nope' }]) {
      expect(parseComposeCacheState(raw)).toEqual(EMPTY_COMPOSE_CACHE);
    }
  });

  it('keeps only entries that still point at a blob', () => {
    const state = parseComposeCacheState({
      cutouts: { 'url:a': { blobId: 'b1', width: 10, height: 20, at: 5 }, 'url:b': { width: 1 } },
      results: { k1: { blobId: 'b2', at: 7 }, k2: {} },
      bindings: { k3: { hero: 'url:a', box: null, confidence: 0.5, reason: 'r', at: 9 }, k4: {} },
    });
    expect(Object.keys(state.cutouts)).toEqual(['url:a']);
    expect(Object.keys(state.results)).toEqual(['k1']);
    expect(Object.keys(state.bindings)).toEqual(['k3']);
    expect(state.cutouts['url:a']).toEqual({ blobId: 'b1', width: 10, height: 20, at: 5 });
    expect(state.bindings['k3'].box).toBeNull();
  });

  it('keeps a binding that named a box but no hero', () => {
    const state = parseComposeCacheState({
      bindings: { k: { box: 'url:b', confidence: 1, reason: '', at: 1 } },
    });
    expect(state.bindings.k).toMatchObject({ hero: '', box: 'url:b' });
  });

  it('names missing numbers 0 rather than NaN', () => {
    const state = parseComposeCacheState({
      cutouts: { k: { blobId: 'b', width: 'wide', at: null } },
      bindings: { b: { hero: 'url:a', confidence: 'high' } },
    });
    expect(state.cutouts.k.width).toBe(0);
    expect(state.cutouts.k.at).toBe(0);
    expect(state.bindings.b.confidence).toBe(0);
  });

  it('prunes over-long sections down to the newest entries', () => {
    const raw: Record<string, { blobId: string; at: number }> = {};
    for (let index = 0; index < COMPOSE_CACHE_MAX_CUTOUTS + 5; index += 1) {
      raw[`url:${index}`] = { blobId: `b${index}`, at: index };
    }
    const state = parseComposeCacheState({ cutouts: raw });
    expect(Object.keys(state.cutouts)).toHaveLength(COMPOSE_CACHE_MAX_CUTOUTS);
    // Newest kept, oldest dropped.
    expect(state.cutouts[`url:${COMPOSE_CACHE_MAX_CUTOUTS + 4}`]).toBeDefined();
    expect(state.cutouts['url:0']).toBeUndefined();
  });

  it('leaves a short section untouched', () => {
    const section = { a: { at: 1 }, b: { at: 2 } };
    expect(pruneSection(section, 5)).toBe(section);
  });
});

describe('createComposeCache', () => {
  it('writes the blob and the index under the deterministic id', async () => {
    const { ports, values, blobs } = fakePorts();
    const cache = createComposeCache(ports);
    const identity = imageIdentity({ url: 'https://x/1.jpg' });

    const entry = await cache.putCutout(identity, png('cut'), { width: 640, height: 480 });

    expect(entry.blobId).toBe(cutoutBlobIdFor(identity));
    expect(await blobs.get(entry.blobId)?.text()).toBe('cut');
    expect(await cache.getCutout(identity)).toEqual({
      blobId: entry.blobId,
      width: 640,
      height: 480,
      at: 1000,
    });
    expect(values.has(STORAGE_KEYS.composeCache)).toBe(true);
  });

  it('returns null for an unknown identity or key', async () => {
    const { ports } = fakePorts();
    const cache = createComposeCache(ports);
    expect(await cache.getCutout('url:nope')).toBeNull();
    expect(await cache.getCutout('')).toBeNull();
    expect(await cache.getBinding('nope')).toBeNull();
    expect(await cache.getBinding('')).toBeNull();
    expect(await cache.getResult('nope')).toBeNull();
    expect(await cache.readResultBlob('nope')).toBeNull();
  });

  it('reads back a binding with its timestamp', async () => {
    const { ports, clock } = fakePorts();
    const cache = createComposeCache(ports);
    clock.now = 2222;
    await cache.putBinding('k', { hero: 'url:a', box: null, confidence: 0.8, reason: '主图' });

    expect(await cache.getBinding('k')).toEqual({
      hero: 'url:a',
      box: null,
      confidence: 0.8,
      reason: '主图',
      at: 2222,
    });
  });

  it('round-trips a composed PNG', async () => {
    const { ports } = fakePorts();
    const cache = createComposeCache(ports);
    const entry = await cache.putResult('key1', png('composite'));

    expect(entry.blobId).toBe(resultBlobIdFor('key1'));
    expect(await (await cache.readResultBlob('key1'))?.text()).toBe('composite');
    expect(await cache.getResult('key1')).toEqual({ blobId: entry.blobId, at: 1000 });
  });

  it('reports a stale index entry as "no blob", not as an error', async () => {
    // The index can outlive the blob (a cleared profile, a failed write).
    const { ports, blobs } = fakePorts();
    const cache = createComposeCache(ports);
    const entry = await cache.putCutout('url:a', png('cut'), { width: 1, height: 1 });
    blobs.delete(entry.blobId);

    expect(await cache.hasCutoutBlob(entry)).toBe(false);
  });

  it('counts what it holds', async () => {
    const { ports } = fakePorts();
    const cache = createComposeCache(ports);
    await cache.putCutout('url:a', png('a'), { width: 1, height: 1 });
    await cache.putBinding('k', { hero: 'url:a', box: null, confidence: 1, reason: '' });
    await cache.putResult('r', png('r'));

    expect(await cache.stats()).toEqual({ cutouts: 1, bindings: 1, results: 1 });
  });

  it('clears the index and deletes the blobs it pointed at', async () => {
    const { ports, blobs, deleted } = fakePorts();
    const cache = createComposeCache(ports);
    const cutout = await cache.putCutout('url:a', png('a'), { width: 1, height: 1 });
    const result = await cache.putResult('r', png('r'));

    const removed = await cache.clear();

    expect(removed).toBe(2);
    expect(deleted.sort()).toEqual([cutout.blobId, result.blobId].sort());
    expect(blobs.size).toBe(0);
    expect(await cache.stats()).toEqual({ cutouts: 0, bindings: 0, results: 0 });
  });

  it('survives storage that refuses to write', async () => {
    const { ports } = fakePorts();
    const broken: ComposeCachePorts = {
      ...ports,
      async writeLocal() {
        throw new Error('quota exceeded');
      },
      async readLocal() {
        throw new Error('denied');
      },
    };
    const cache = createComposeCache(broken);

    // The write is swallowed, and reads fall back to "empty", never to a throw.
    await expect(
      cache.putCutout('url:a', png('a'), { width: 1, height: 1 }),
    ).resolves.toMatchObject({ blobId: cutoutBlobIdFor('url:a') });
    expect(await cache.read()).toEqual(EMPTY_COMPOSE_CACHE);
    expect(await cache.getCutout('url:a')).toBeNull();
  });
});
