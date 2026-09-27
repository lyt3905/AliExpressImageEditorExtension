/**
 * Watermark frame state for the editor.
 *
 * The watermark deliberately lives OUTSIDE `EditorDocument` / the undo history.
 * It is a locked frame that has to survive UNDO, REDO and CLEAR, so instead of
 * adding guards everywhere it simply is not part of the document — the reducer
 * cannot reach it even in principle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CANVAS_SIZE, WATERMARK_LAYER_ID } from '../../shared/constants';
import { messageOf } from '../../shared/errors';
import type { EditorLayer, WatermarkMeta } from '../../shared/types';
import { getDefaultWatermark, listWatermarks, loadWatermarkBlob } from '../../services/watermark-store';

export interface UseWatermarkResult {
  /** All configured watermarks, for the toolbar switcher. */
  options: WatermarkMeta[];
  /** Currently applied watermark (null = none). */
  activeId: string | null;
  /** Whether the frame is drawn right now. */
  enabled: boolean;
  /** Ready-to-render locked node; null when hidden or nothing is configured. */
  layer: EditorLayer | null;
  image: HTMLImageElement | undefined;
  meta: WatermarkMeta | null;
  error: string | null;
  loading: boolean;
  setEnabled: (enabled: boolean) => void;
  selectWatermark: (id: string | null) => void;
}

/**
 * Fit a watermark to the canvas: longest side becomes exactly 800 and the frame
 * is centred, without ever stretching it out of proportion.
 */
export function fitWatermarkToCanvas(
  width: number,
  height: number,
): { x: number; y: number; scale: number } {
  const longest = Math.max(width, height);
  const scale = longest > 0 ? CANVAS_SIZE / longest : 1;
  return { x: CANVAS_SIZE / 2, y: CANVAS_SIZE / 2, scale };
}

export function createWatermarkLayer(meta: WatermarkMeta): EditorLayer {
  const width = meta.width > 0 ? meta.width : CANVAS_SIZE;
  const height = meta.height > 0 ? meta.height : CANVAS_SIZE;
  const { x, y, scale } = fitWatermarkToCanvas(width, height);
  return {
    id: WATERMARK_LAYER_ID,
    materialId: `material-watermark-${meta.id}`,
    blobId: meta.blobId,
    sourceWidth: width,
    sourceHeight: height,
    x,
    y,
    scale,
    rotation: 0,
    kind: 'watermark',
  };
}

export function useWatermark(): UseWatermarkResult {
  const [options, setOptions] = useState<WatermarkMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [image, setImage] = useState<HTMLImageElement | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const objectUrlRef = useRef<string | null>(null);

  // ---- read the configured list once, then apply the default
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await listWatermarks();
        if (cancelled) return;
        setOptions(list);
        const preferred = await getDefaultWatermark();
        if (cancelled) return;
        setActiveId(preferred?.id ?? null);
      } catch (caught) {
        if (!cancelled) setError(messageOf(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const meta = useMemo(
    () => options.find((entry) => entry.id === activeId) ?? null,
    [options, activeId],
  );

  // ---- decode the blob behind the active watermark
  useEffect(() => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setImage(undefined);
    if (!meta) return;

    let cancelled = false;
    void (async () => {
      try {
        const blob = await loadWatermarkBlob(meta);
        if (!blob) throw new Error(`水印图片已丢失：${meta.name}`);
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrlRef.current = url;

        const element = new Image();
        element.onload = () => {
          if (!cancelled) setImage(element);
        };
        element.onerror = () => {
          if (!cancelled) setError(`水印图片无法解码：${meta.name}`);
        };
        element.src = url;
      } catch (caught) {
        if (!cancelled) setError(messageOf(caught));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [meta]);

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );

  const layer = useMemo(() => (meta && enabled ? createWatermarkLayer(meta) : null), [meta, enabled]);

  const selectWatermark = useCallback((id: string | null) => {
    setError(null);
    setActiveId(id);
    // Switching from the toolbar implies "I want it visible".
    if (id) setEnabled(true);
  }, []);

  return {
    options,
    activeId,
    enabled,
    layer,
    image,
    meta,
    error,
    loading,
    setEnabled,
    selectWatermark,
  };
}
