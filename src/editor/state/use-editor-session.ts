/**
 * Loads a session from IndexedDB, rebuilds materials, restores cutout state and
 * runs the automatic cutout pipeline.
 *
 * Refresh recovery rules (spec §23):
 *   success                  -> the cutout material is restored as-is
 *   failed                   -> stays failed, the user can press 重试
 *   queued/uploading/processing -> reset to idle and re-queued
 */

import { useEffect, useRef, useState } from 'react';
import { CUTOUT_CONCURRENCY } from '../../shared/constants';
import { AppError, ErrorCode, messageOf } from '../../shared/errors';
import type {
  CutoutStatus,
  EditorDocument,
  EditorMaterial,
  EditorSessionRecord,
  SessionImage,
} from '../../shared/types';
import { CutoutQueue } from '../../services/cutout-queue';
import { HttpCutoutClient } from '../../services/cutout-client';
import { getBlob, getSession, patchSessionImage, putBlob, putSession } from '../../services/indexed-db';
import { readBlobSize } from '../../services/image-size';
import { loadSettings } from '../../services/settings';
import { emptyDocument } from './editor-reducer';

const IN_FLIGHT: ReadonlySet<CutoutStatus> = new Set<CutoutStatus>(['queued', 'uploading', 'processing']);

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
  retryCutout: (imageId: string) => void;
}

function documentKey(sessionId: string): string {
  return `aiee:doc:${sessionId}`;
}

async function loadStoredDocument(sessionId: string): Promise<EditorDocument> {
  try {
    const key = documentKey(sessionId);
    const stored = await chrome.storage.local.get(key);
    const value = stored?.[key] as EditorDocument | undefined;
    if (value && Array.isArray(value.layers)) {
      // Drop layers whose material no longer exists (checked later by the caller).
      return { layers: value.layers.filter((layer) => layer && typeof layer.id === 'string') };
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

  const imagesRef = useRef<SessionImage[]>([]);
  const queueRef = useRef<CutoutQueue | null>(null);
  const clientRef = useRef<HttpCutoutClient | null>(null);
  const objectUrlsRef = useRef<Map<string, string>>(new Map());
  /** Serialises read-modify-write persistence of the session record. */
  const persistChainRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    if (!sessionId) {
      setFatalError('缺少 session 参数，无法打开编辑器');
      setLoading(false);
      return;
    }

    let cancelled = false;
    const objectUrls = objectUrlsRef.current;
    const persistChain = persistChainRef;

    const trackUrl = (blobId: string, blob: Blob): string => {
      const existing = objectUrls.get(blobId);
      if (existing) return existing;
      const url = URL.createObjectURL(blob);
      objectUrls.set(blobId, url);
      return url;
    };

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
        const result = await client.cutout(original);

        const cutoutBlobId = `${image.blobId}-cutout`;
        await putBlob(cutoutBlobId, result.blob);
        const size = await readBlobSize(result.blob);
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

        imagesRef.current = recovered;
        setSession({ ...record, images: recovered });
        setMaterials(restoredMaterials);
        setStatusByImageId(statuses);
        setProgress({
          total: recovered.length,
          success: recovered.filter((image) => image.cutoutStatus === 'success').length,
          failed: recovered.filter((image) => image.cutoutStatus === 'failed').length,
          active: 0,
          waiting: 0,
        });

        // Persist the recovered statuses so a second refresh is a no-op.
        if (changed) {
          const merged = { ...record, images: recovered };
          persistChain.current = persistChain.current.then(() => putSession(merged)).catch(() => undefined);
        }

        const storedDocument = await loadStoredDocument(sessionId);
        const materialIds = new Set(restoredMaterials.map((material) => material.id));
        if (!cancelled) {
          setInitialDocument({ layers: storedDocument.layers.filter((layer) => materialIds.has(layer.materialId)) });
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
    };
  }, [sessionId]);

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
    retryCutout,
  };
}
