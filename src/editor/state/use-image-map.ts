import { useEffect, useRef, useState } from 'react';

export type ImageMap = Record<string, HTMLImageElement>;

/**
 * Loads object URLs into HTMLImageElements for Konva.
 * Already-loaded URLs are never re-fetched; the map object identity changes
 * only when a new image becomes available (so React re-renders exactly once).
 */
export function useImageMap(urls: readonly string[]): ImageMap {
  const [images, setImages] = useState<ImageMap>({});
  const loadedRef = useRef<Set<string>>(new Set(loadedRefInit()));
  const key = urls.join('|');

  useEffect(() => {
    const pending = urls.filter((url) => url && !loadedRef.current.has(url));
    if (pending.length === 0) return;

    let cancelled = false;
    const loaded: ImageMap = {};
    let remaining = pending.length;

    const settle = () => {
      remaining -= 1;
      if (remaining > 0 || cancelled) return;
      if (Object.keys(loaded).length === 0) return;
      setImages((previous) => ({ ...previous, ...loaded }));
    };

    for (const url of pending) {
      const image = new Image();
      image.onload = () => {
        loadedRef.current.add(url);
        loaded[url] = image;
        settle();
      };
      image.onerror = () => {
        settle();
      };
      image.src = url;
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return images;
}

function loadedRefInit(): Set<string> {
  return new Set<string>();
}
