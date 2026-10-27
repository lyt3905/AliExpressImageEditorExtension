/**
 * Loads a session from IndexedDB, rebuilds materials, restores cutout state and
 * runs the automatic cutout pipeline.
 *
 * Refresh recovery rules (spec §23):
 *   success                  -> the cutout material is restored as-is
 *   failed                   -> stays failed, the user can press 重试
 *   queued/uploading/processing -> reset to idle and re-queued
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { CUTOUT_CONCURRENCY, CUTOUT_TOTAL_TIMEOUT_MS } from '../../shared/constants';
import { AppError, ErrorCode, messageOf } from '../../shared/errors';
import type {
  CutoutStatus,
  EditorDocument,
  EditorLayer,
  EditorMaterial,
  EditorSessionRecord,
  SessionImage,
} from '../../shared/types';
import { CutoutQueue } from '../../services/cutout-queue';
import { HttpCutoutClient } from '../../services/cutout-client';
import { createComposeCache, imageIdentity } from '../../services/compose-cache';
import { getBlob, getSession, patchSessionImage, putBlob, putSession } from '../../services/indexed-db';
import { readBlobSize } from '../../services/image-size';
import { loadSettings } from '../../services/settings';
import { appendUploadedImages, type UploadOutcome } from '../../services/upload-images';
import { emptyDocument, keepLayerWithMaterials, restoreStoredLayer } from './editor-reducer';

const IN_FLIGHT: ReadonlySet<CutoutStatus> = new Set<CutoutStatus>(['queued', 'uploading', 'processing']);

/**
 * Cache identity of one session image.
 *
 * `bytes` is only needed for uploaded files (they have no url); the page-scanned
 * ones are identified by their CDN url, which is what makes reuse work across
 * sessions. See `services/compose-cache.ts` for the whole scheme.
 */
function identityOf(image: SessionImage, bytes?: number): string {
  return imageIdentity({
    url: image.url,
    label: image.label,
    width: image.width,
    height: image.height,
    // The stored size wins: it is what the editor computes the same identity
    // from later, when it no longer has the blob at hand.
    bytes: image.bytes ?? bytes,
    blobId: image.blobId,
  });
}

/**
 * Reject `promise` if it has not settled within `ms`.
 *
 * Defence in depth behind the per-stage fetch timeouts: whatever goes wrong in
 * the chain, a cutout task must always reach a terminal state, otherwise the
 * image sits on 「处理中」 forever and the only fix is reloading the editor.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AppError(ErrorCode.CUTOUT_TIMEOUT, message)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface MaterialStatusEntry {
  status: CutoutStatus;
  error?: string;
}

export interface CutoutProgress {
  total: number;
  success: number;
  failed: number;
  active: number;
  waiting: number;
}

export interface EditorSessionState {
  loading: boolean;
  fatalError: string | null;
  session: EditorSessionRecord | null;
  materials: EditorMaterial[];
  statusByImageId: Record<string, MaterialStatusEntry>;
  initialDocument: EditorDocument;
  progress: CutoutProgress;
  /**
   * How many cut-outs were adopted from the local cache instead of being
   * requested again (0 for a first visit). Purely informational — the panel says
   * "已复用上次的抠图" with it.
   */
  cachedCutouts: number;
  retryCutout: (imageId: string) => void;
  /**
   * Add local files (picker or clipboard paste) to the session and hand them to
   * the cutout queue. Resolves with the outcome for the notice bar, or `null`
   * when the session is not ready yet.
   */
  addUploadedImages: (files: File[]) => Promise<UploadOutcome | null>;
}

function documentKey(sessionId: string): string {
  return `aiee:doc:${sessionId}`;
}

async function loadStoredDocument(sessionId: string): Promise<EditorDocument> {
  try {
    const key = documentKey(sessionId);
    const stored = await chrome.storage.local.get(key);
    const value = stored?.[key] as { layers?: unknown[] } | undefined;
    if (value && Array.isArray(value.layers)) {
      // Text layers are rebuilt field by field; picture layers keep their stored
      // shape and are filtered by material availability by the caller.
      const layers = value.layers
        .map(restoreStoredLayer)
        .filter((layer): layer is EditorLayer => layer !== null);
      return { layers };
    }
  } catch {
    /* ignore */
  }
  return emptyDocument();
}

export function useEditorSession(sessionId: string | null): EditorSessionState {
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [session, setSession] = useState<EditorSessionRecord | null>(null);
  const [materials, setMaterials] = useState<EditorMaterial[]>([]);
  const [statusByImageId, setStatusByImageId] = useState<Record<string, MaterialStatusEntry>>({});
  const [initialDocument, setInitialDocument] = useState<EditorDocument>(emptyDocument);
  const [progress, setProgress] = useState<CutoutProgress>({ total: 0, success: 0, failed: 0, active: 0, waiting: 0 });
  const [cachedCutouts, setCachedCutouts] = useState(0);

  const imagesRef = useRef<SessionImage[]>([]);
  /**
   * Session metadata as loaded. The image list is read from `imagesRef` — that
   * one is patched in place as cutouts finish, so this snapshot would be stale.
   */
  const sessionRef = useRef<EditorSessionRecord | null>(null);
  const queueRef = useRef<CutoutQueue | null>(null);
  const clientRef = useRef<HttpCutoutClient | null>(null);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  /** Serialises read-modify-write persistence of the session record. */
  const persistChainRef = useRef<Promise<unknown>>(Promise.resolve());
  /** Serialises uploads, which are also a read-modify-write of the record. */
  const uploadChainRef = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * One object URL per blob, cached for the lifetime of the hook.
   *
   * Hoisted out of the load effect because uploads need it too: a pasted image
   * becomes a material without waiting for a reload.
   */
  const trackUrl = useCallback((blobId: string, blob: Blob): string => {
    const existing = objectUrlsRef.current.get(blobId);
    if (existing) return existing;
    const url = URL.createObjectURL(blob);
    objectUrlsRef.current.set(blobId, url);
    return url;
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setFatalError('缺少 session 参数，无法打开编辑器');
      setLoading(false);
      return;
    }

    let cancelled = false;
    const objectUrls = objectUrlsRef.current;
    const persistChain = persistChainRef;
    // Cut-outs are cached per SOURCE IMAGE, so opening the editor again for the
    // same product adopts yesterday's result instead of calling the server again.
    const cache = createComposeCache();
    let adoptedFromCache = 0;

    const setStatus = (imageId: string, entry: MaterialStatusEntry) => {
      if (cancelled) return;
      setStatusByImageId((previous) => ({ ...previous, [imageId]: entry }));
    };

    const updateImage = (imageId: string, patch: Partial<SessionImage>) => {
      imagesRef.current = imagesRef.current.map((image) =>
        image.id === imageId ? { ...image, ...patch } : image,
      );
    };

    const persist = (imageId: string, patch: Partial<SessionImage>) => {
      persistChain.current = persistChain.current
        .then(() => patchSessionImage(sessionId, imageId, patch))
        .catch(() => undefined);
      return persistChain.current;
    };

    const getClient = async (): Promise<HttpCutoutClient> => {
      if (!clientRef.current) {
        const settings = await loadSettings();
        clientRef.current = new HttpCutoutClient({ baseUrl: settings.serverUrl });
      }
      return clientRef.current;
    };

    /** One cutout job. Failures are contained here: they never stop the queue. */
    const runCutout = async (imageId: string): Promise<void> => {
      const image = imagesRef.current.find((entry) => entry.id === imageId);
      if (!image) return;

      // Guard against duplicate submissions (spec §21).
      if (image.cutoutStatus === 'success' && image.cutoutBlobId) return;
      if (image.cutoutStatus === 'uploading' || image.cutoutStatus === 'processing') return;

      setStatus(imageId, { status: 'uploading' });
      updateImage(imageId, { cutoutStatus: 'uploading', cutoutError: undefined });

      try {
        const original = await getBlob(image.blobId);
        if (!original) throw new AppError(ErrorCode.STORE_FAILED, '原图数据已丢失，无法抠图');

        setStatus(imageId, { status: 'processing' });
        updateImage(imageId, { cutoutStatus: 'processing' });

        const client = await getClient();
        // Watchdog: the per-stage timeouts should fire first, but a hung
        // promise used to leave the card stuck on 「处理中」 with no retry.
        const result = await withDeadline(
          client.cutout(original),
          CUTOUT_TOTAL_TIMEOUT_MS,
          '抠图超时：服务端长时间无响应，请稍后点「重试」',
        );

        const size = await readBlobSize(result.blob);
        const identity = identityOf(image, original.size);
        // The cache id is deterministic, so a second session pointing at the same
        // product photo reads one blob instead of storing a second copy.
        const cached = await cache.putCutout(identity, result.blob, size).catch(() => null);
        const cutoutBlobId = cached?.blobId ?? `${image.blobId}-cutout`;
        if (!cached) await putBlob(cutoutBlobId, result.blob);
        const patch: Partial<SessionImage> = {
          cutoutStatus: 'success',
          cutoutBlobId,
          cutoutWidth: size.width,
          cutoutHeight: size.height,
          cutoutError: undefined,
        };

        updateImage(imageId, patch);
        await persist(imageId, patch);

        const url = trackUrl(cutoutBlobId, result.blob);
        const material: EditorMaterial = {
          id: `material-cutout-${imageId}`,
          imageId,
          blobId: cutoutBlobId,
          kind: 'cutout',
          width: size.width || image.width,
          height: size.height || image.height,
          url,
          label: image.label || '抠图',
        };
        if (!cancelled) {
          setMaterials((previous) =>
            previous.some((entry) => entry.id === material.id) ? previous : [...previous, material],
          );
          setStatus(imageId, { status: 'success' });
          setProgress((previous) => ({ ...previous, success: previous.success + 1 }));
        }
      } catch (error) {
        const message = error instanceof AppError ? error.message : messageOf(error);
        const patch: Partial<SessionImage> = { cutoutStatus: 'failed', cutoutError: message };
        updateImage(imageId, patch);
        await persist(imageId, patch);
        if (!cancelled) {
          setStatus(imageId, { status: 'failed', error: message });
          setProgress((previous) => ({ ...previous, failed: previous.failed + 1 }));
        }
      }
    };

    void (async () => {
      try {
        const record = await getSession(sessionId);
        if (!record) throw new AppError(ErrorCode.SESSION_NOT_FOUND, '找不到该编辑会话');

        const recovered: SessionImage[] = [];
        const restoredMaterials: EditorMaterial[] = [];
        const statuses: Record<string, MaterialStatusEntry> = {};
        let changed = false;

        for (const image of record.images) {
          const originalBlob = await getBlob(image.blobId).catch(() => null);
          if (!originalBlob) {
            changed = true;
            continue;
          }

          const originalSize = await readBlobSize(originalBlob);
          const width = image.width || originalSize.width;
          const height = image.height || originalSize.height;

          let next: SessionImage = { ...image, width, height };
          if (IN_FLIGHT.has(next.cutoutStatus)) {
            next = { ...next, cutoutStatus: 'idle', cutoutError: undefined };
            changed = true;
          }

          /*
            Adopt a cut-out made for another session of the same product.

            This has to happen BEFORE the enqueue loop below, and it has to leave
            `cutoutStatus` on success: that is what stops the image from being sent
            to the server again. The blob is shared, not copied — the id is derived
            from the source image, so the same photo always lands on the same id.
          */
          if (next.cutoutStatus !== 'success') {
            const identity = identityOf(next, originalBlob.size);
            const cachedCutout = await cache.getCutout(identity).catch(() => null);
            const cachedBlob = cachedCutout ? await getBlob(cachedCutout.blobId).catch(() => null) : null;
            if (cachedCutout && cachedBlob) {
              next = {
                ...next,
                cutoutStatus: 'success',
                cutoutBlobId: cachedCutout.blobId,
                cutoutWidth: cachedCutout.width || width,
                cutoutHeight: cachedCutout.height || height,
                cutoutError: undefined,
              };
              changed = true;
              adoptedFromCache += 1;
            }
          }

          let cutoutBlob: Blob | null = null;
          if (next.cutoutStatus === 'success' && next.cutoutBlobId) {
            cutoutBlob = await getBlob(next.cutoutBlobId).catch(() => null);
            if (!cutoutBlob) {
              next = { ...next, cutoutStatus: 'idle', cutoutBlobId: undefined };
              changed = true;
            }
          }

          const originalUrl = trackUrl(next.blobId, originalBlob);
          restoredMaterials.push({
            id: `material-original-${next.id}`,
            imageId: next.id,
            blobId: next.blobId,
            kind: 'original',
            width,
            height,
            url: originalUrl,
            label: next.label || '原图',
          });

          if (next.cutoutStatus === 'success' && cutoutBlob && next.cutoutBlobId) {
            const cutoutSize = await readBlobSize(cutoutBlob);
            restoredMaterials.push({
              id: `material-cutout-${next.id}`,
              imageId: next.id,
              blobId: next.cutoutBlobId,
              kind: 'cutout',
              width: next.cutoutWidth || cutoutSize.width || width,
              height: next.cutoutHeight || cutoutSize.height || height,
              url: trackUrl(next.cutoutBlobId, cutoutBlob),
              label: next.label || '抠图',
            });
          }

          recovered.push(next);
          statuses[next.id] = next.cutoutError
            ? { status: next.cutoutStatus, error: next.cutoutError }
            : { status: next.cutoutStatus };
        }

        if (cancelled) return;

        if (recovered.length === 0) {
          throw new AppError(ErrorCode.SESSION_NOT_FOUND, '会话中没有任何可用的原图数据');
        }

        const current: EditorSessionRecord = { ...record, images: recovered };
        imagesRef.current = recovered;
        sessionRef.current = current;
        setSession(current);
        setMaterials(restoredMaterials);
        setStatusByImageId(statuses);
        setProgress({
          total: recovered.length,
          success: recovered.filter((image) => image.cutoutStatus === 'success').length,
          failed: recovered.filter((image) => image.cutoutStatus === 'failed').length,
          active: 0,
          waiting: 0,
        });
        setCachedCutouts(adoptedFromCache);

        // Persist the recovered statuses so a second refresh is a no-op.
        if (changed) {
          persistChain.current = persistChain.current.then(() => putSession(current)).catch(() => undefined);
        }

        const storedDocument = await loadStoredDocument(sessionId);
        const materialIds = new Set(restoredMaterials.map((material) => material.id));
        if (!cancelled) {
          // Text layers carry no materialId, so `keepLayerWithMaterials` keeps them
          // unconditionally — a reload must never wipe the text off the canvas.
          setInitialDocument({ layers: keepLayerWithMaterials(storedDocument.layers, materialIds) });
        }

        // ---- automatic cutout pipeline ----
        const queue = new CutoutQueue({
          concurrency: CUTOUT_CONCURRENCY,
          run: runCutout,
          onProgress: (active, waiting) => {
            if (!cancelled) setProgress((previous) => ({ ...previous, active, waiting }));
          },
        });
        queueRef.current = queue;

        const queued: SessionImage[] = [];
        for (const image of recovered) {
          if (image.selected && image.cutoutStatus === 'idle') {
            queued.push({ ...image, cutoutStatus: 'queued' });
            setStatus(image.id, { status: 'queued' });
            queue.enqueue(image.id);
          }
        }
        if (queued.length) {
          imagesRef.current = recovered.map((image) =>
            queued.some((entry) => entry.id === image.id) ? { ...image, cutoutStatus: 'queued' } : image,
          );
        }

        if (!cancelled) setLoading(false);
      } catch (error) {
        if (cancelled) return;
        setFatalError(error instanceof AppError ? error.message : messageOf(error));
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      queueRef.current?.clear();
      queueRef.current = null;
      for (const url of objectUrls.values()) URL.revokeObjectURL(url);
      objectUrls.clear();
      imagesRef.current = [];
      sessionRef.current = null;
    };
  }, [sessionId, trackUrl]);

  /**
   * The actual upload work: blobs and the session record are persisted first,
   * then the editor state is updated — from the store's point of view an upload
   * is committed the moment this resolves.
   */
  const uploadFiles = useCallback(
    async (files: File[]): Promise<UploadOutcome | null> => {
      const base = sessionRef.current;
      if (!sessionId || !base || files.length === 0) return null;

      // `imagesRef` is the live list (cutout statuses are patched in place), so
      // persisting `base.images` would roll those patches back.
      const outcome = await appendUploadedImages(
        { ...base, images: imagesRef.current },
        files.map((file) => ({ name: file.name, blob: file })),
      );
      if (outcome.added.length === 0) return outcome;

      const newMaterials: EditorMaterial[] = [];
      for (const image of outcome.added) {
        const blob = await getBlob(image.blobId).catch(() => null);
        if (!blob) continue;
        newMaterials.push({
          id: `material-original-${image.id}`,
          imageId: image.id,
          blobId: image.blobId,
          kind: 'original',
          width: image.width,
          height: image.height,
          url: trackUrl(image.blobId, blob),
          label: image.label || '原图',
        });
      }

      // Merge rather than replace: a cutout can finish while the blobs are being
      // written, and `imagesRef` is where those status patches live. Replacing
      // the array wholesale would roll them back.
      const live = new Map(imagesRef.current.map((entry) => [entry.id, entry]));
      imagesRef.current = outcome.record.images.map((entry) => live.get(entry.id) ?? entry);
      sessionRef.current = outcome.record;
      setSession(outcome.record);
      if (newMaterials.length) setMaterials((previous) => [...previous, ...newMaterials]);

      for (const image of outcome.added) {
        setStatusByImageId((previous) => ({ ...previous, [image.id]: { status: 'queued' } }));
        imagesRef.current = imagesRef.current.map((entry) =>
          entry.id === image.id ? { ...entry, cutoutStatus: 'queued' } : entry,
        );
        // One more job means the denominator has to grow with it — otherwise
        // 抠图进度 x/y could never reach y.
        setProgress((previous) => ({ ...previous, total: previous.total + 1 }));
        // A no-op when the queue is gone (fatal error screen): the image is
        // already persisted, so a reload picks it up.
        queueRef.current?.enqueue(image.id);
      }

      return outcome;
    },
    [sessionId, trackUrl],
  );

  /**
   * Local uploads (file picker / clipboard paste).
   *
   * Serialised on purpose: two uploads racing would each branch off the same
   * record snapshot, and the later `putSession` would drop the earlier batch —
   * leaving its blob orphaned. Queued, every upload sees the previous result.
   */
  const addUploadedImages = useCallback(
    (files: File[]): Promise<UploadOutcome | null> => {
      const run = uploadChainRef.current.then(() => uploadFiles(files));
      // Swallowed here so one failure cannot poison the chain for the next call.
      uploadChainRef.current = run.catch(() => undefined);
      return run;
    },
    [uploadFiles],
  );

  const updateLocalStatus = (imageId: string, status: CutoutStatus): void => {
    setStatusByImageId((previous) => ({ ...previous, [imageId]: { status } }));
    setProgress((previous) => ({ ...previous, failed: Math.max(0, previous.failed - 1) }));
    const image = imagesRef.current.find((entry) => entry.id === imageId);
    if (!image) return;
    imagesRef.current = imagesRef.current.map((entry) =>
      entry.id === imageId ? { ...entry, cutoutStatus: status, cutoutError: undefined } : entry,
    );
    persistChainRef.current = persistChainRef.current
      .then(() => patchSessionImage(sessionId as string, imageId, { cutoutStatus: status, cutoutError: undefined }))
      .catch(() => undefined);
  };

  const retryCutout = (imageId: string): void => {
    updateLocalStatus(imageId, 'queued');
    queueRef.current?.retry(imageId);
  };

  return {
    loading,
    fatalError,
    session,
    materials,
    statusByImageId,
    initialDocument,
    progress,
    cachedCutouts,
    retryCutout,
    addUploadedImages,
  };
}
