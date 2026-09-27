/**
 * Clipboard paste → new session images.
 *
 * Screenshots are the main use case: `Win + Shift + S` / `Ctrl + C` on an image
 * puts a PNG on the clipboard, and the user expects it to show up on the canvas
 * *and* be cut out without saving a file first.
 *
 * The payload is collected from `clipboardData` and handed to the same upload
 * path the file picker uses, so the two entry points cannot drift apart. There
 * is deliberately no `drop` listener, so there is no double-fire to guard
 * against.
 */

import { useEffect, useRef } from 'react';
import { UPLOAD_DEFAULT_LABEL } from '../../services/upload-images';

const IMAGE_MIME = /^image\//i;

function extensionForMime(type: string): string {
  switch (type.toLowerCase()) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    default:
      return '';
  }
}

/**
 * Every image carried by one clipboard payload, in clipboard order.
 *
 * `clipboardData.files` covers screenshots and copied files. A few payloads only
 * expose `items`, so that is the fallback — and the item's `type` is what lets a
 * pasted *text* selection fall through untouched.
 */
export function collectPastedImages(clipboard: DataTransfer | null): File[] {
  if (!clipboard) return [];

  const files: File[] = [];
  const seen = new Set<File>();
  const push = (file: File | null): void => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    files.push(file);
  };

  for (const file of Array.from(clipboard.files ?? [])) push(file);

  if (files.length === 0) {
    for (const item of Array.from(clipboard.items ?? [])) {
      if (item.kind !== 'file') continue;
      if (item.type && !IMAGE_MIME.test(item.type)) continue;
      push(item.getAsFile());
    }
  }

  return files;
}

/**
 * A raw screenshot has an empty `name`, which would leave every pasted material
 * labelled as a blank card. Give those a readable label (and extension) instead.
 */
export function namePastedFiles(files: readonly File[]): File[] {
  return files.map((file, index) => {
    if (file.name.trim()) return file;
    return new File([file], `${UPLOAD_DEFAULT_LABEL}-${index + 1}${extensionForMime(file.type)}`, {
      type: file.type,
    });
  });
}

export interface UsePasteImagesOptions {
  /** Detach while the editor is still loading or has failed to open. */
  enabled: boolean;
  onPaste: (files: File[]) => void;
}

export function usePasteImages({ enabled, onPaste }: UsePasteImagesOptions): void {
  // Latest-callback ref: the listener is attached once per `enabled` change, so
  // an inline `onPaste` cannot churn the subscription on every render.
  const handlerRef = useRef(onPaste);
  useEffect(() => {
    handlerRef.current = onPaste;
  });

  useEffect(() => {
    if (!enabled) return undefined;

    const handlePaste = (event: ClipboardEvent): void => {
      const files = namePastedFiles(collectPastedImages(event.clipboardData));
      // No image on the clipboard: leave the event alone so pasting text into
      // the text-properties field keeps working normally.
      if (files.length === 0) return;
      event.preventDefault();
      handlerRef.current(files);
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [enabled]);
}
