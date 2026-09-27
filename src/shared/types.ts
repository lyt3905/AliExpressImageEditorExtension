/** Domain types shared by content script, service worker and editor. */

// ---------------------------------------------------------------- page scanning

export interface ScannedImage {
  /** Stable id derived from the normalised URL. */
  id: string;
  /** 0-based order on the page. */
  index: number;
  /** URL as read from the DOM (`currentSrc || src`). */
  url: string;
  /** URL normalised for dedupe (size/quality suffixes stripped). */
  normalizedUrl: string;
  width: number;
  height: number;
  alt?: string;
  /** Page-provided slot label, e.g. 商品正面图 / 商品背面图. */
  label?: string;
  sourceType: 'main';
}

export interface PageImageAdapter {
  isSupportedPage(): boolean;
  scanMainImages(): ScannedImage[];
}

// ---------------------------------------------------------------- session

export type CutoutStatus = 'idle' | 'queued' | 'uploading' | 'processing' | 'success' | 'failed';

export interface SessionImage {
  id: string;
  index: number;
  /** Id of the original image blob in IndexedDB. */
  blobId: string;
  url: string;
  width: number;
  height: number;
  /** Page-provided slot label, e.g. 商品正面图 / 商品背面图. */
  label?: string;
  selected: boolean;
  cutoutStatus: CutoutStatus;
  cutoutBlobId?: string;
  cutoutWidth?: number;
  cutoutHeight?: number;
  cutoutError?: string;
}

/** Lightweight session metadata kept in `chrome.storage.session`. */
export interface EditorSessionMeta {
  id: string;
  createdAt: number;
  sourceTabId: number;
  sourceUrl: string;
  imageIds: string[];
}

/** Full session payload persisted in IndexedDB. */
export interface EditorSessionRecord extends EditorSessionMeta {
  images: SessionImage[];
}

// ---------------------------------------------------------------- editor document

/**
 * A node on the canvas.
 *
 * NOTE: the locked watermark frame is NOT part of `EditorDocument.layers` — it
 * lives in `useWatermark` state instead, so UNDO / REDO / CLEAR structurally
 * cannot remove it. The `'watermark'` kind exists so it can reuse this shape.
 */
export interface EditorLayer {
  id: string;
  materialId: string;
  blobId: string;
  sourceWidth: number;
  sourceHeight: number;
  /** Logical centre position on the 800x800 canvas. */
  x: number;
  y: number;
  scale: number;
  /** Degrees. */
  rotation: number;
  kind: 'original' | 'cutout' | 'watermark';
}

export interface EditorDocument {
  layers: EditorLayer[];
}

export type MaterialKind = 'original' | 'cutout';

export interface EditorMaterial {
  id: string;
  imageId: string;
  blobId: string;
  kind: MaterialKind;
  width: number;
  height: number;
  /** Object URL for rendering. */
  url: string;
  label: string;
}

// ---------------------------------------------------------------- watermark

/**
 * A user-configured watermark frame.
 *
 * Several may exist; at most one carries `isDefault`, and that one is applied
 * automatically the next time the editor opens.
 */
export interface WatermarkMeta {
  id: string;
  name: string;
  /** Id of the image blob in IndexedDB (same store as product images). */
  blobId: string;
  width: number;
  height: number;
  isDefault: boolean;
  createdAt: number;
}

// ---------------------------------------------------------------- cutout

export interface CutoutResult {
  blob: Blob;
  mimeType: string;
}

export interface CutoutClient {
  cutout(input: Blob): Promise<CutoutResult>;
}

// ---------------------------------------------------------------- messaging payloads

export interface SessionInput {
  sourceTabId: number;
  sourceUrl: string;
  images: SessionImage[];
}

export interface ExportInput {
  /** PNG as a data URL (Blobs are not structured-cloneable over chrome messaging). */
  dataUrl: string;
  filename: string;
}

// ---------------------------------------------------------------- future

export interface PageImageWriter {
  replaceMainImage(): Promise<void>;
}
