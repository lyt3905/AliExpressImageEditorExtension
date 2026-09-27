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
 * Fields every canvas node shares. `x` / `y` are always the node's CENTRE in
 * the 800x800 logical space.
 */
export interface BaseLayer {
  id: string;
  x: number;
  y: number;
  /** Degrees. */
  rotation: number;
}

/** Payload only picture layers and the watermark frame carry. */
export interface ImagePayload {
  materialId: string;
  blobId: string;
  sourceWidth: number;
  sourceHeight: number;
}

/** A picture on the canvas: an original scan or a cutout result. */
export interface ImageLayer extends BaseLayer, ImagePayload {
  kind: 'original' | 'cutout';
  scale: number;
}

/**
 * A text node.
 *
 * It carries no material / blob / source size — it is plain JSON data rendered
 * directly by Konva, so it must never be routed through `imageForLayer`.
 */
export interface TextLayer extends BaseLayer {
  kind: 'text';
  text: string;
  /** Wrap width in logical px. The box grows downwards as lines wrap. */
  width: number;
  fontSize: number;
  fontFamily: string;
  /** CSS colour, e.g. `#000000`. */
  fill: string;
  fontStyle: 'normal' | 'bold';
  align: 'left' | 'center' | 'right';
  scale: number;
  /** Outline colour — only read while `strokeWidth > 0`. */
  stroke: string;
  /** Outline width in logical px; 0 disables the outline entirely. */
  strokeWidth: number;
  shadowColor: string;
  /** Shadow blur in logical px. No shadow is drawn while blur and both offsets are 0. */
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  /** 0–1 (Konva's unit), not 0–100 — the panel shows it as a percentage. */
  shadowOpacity: number;
}

/**
 * The locked watermark frame.
 *
 * NOTE: it is NOT part of `EditorDocument.layers` — it lives in `useWatermark`
 * state instead, so UNDO / REDO / CLEAR structurally cannot remove it. It only
 * reuses the image payload shape so `EditorStage` can draw it like a picture.
 */
export interface WatermarkLayer extends BaseLayer, ImagePayload {
  kind: 'watermark';
  scale: number;
}

export type EditorLayer = ImageLayer | TextLayer;

/**
 * The fields a layer edit may touch. Identity (`id`), `kind` and the image
 * payload are deliberately absent — they are immutable for a layer's lifetime.
 */
export interface LayerPatch {
  x?: number;
  y?: number;
  scale?: number;
  rotation?: number;
  text?: string;
  width?: number;
  fontSize?: number;
  fontFamily?: string;
  fill?: string;
  fontStyle?: 'normal' | 'bold';
  align?: 'left' | 'center' | 'right';
  stroke?: string;
  strokeWidth?: number;
  shadowColor?: string;
  shadowBlur?: number;
  shadowOffsetX?: number;
  shadowOffsetY?: number;
  shadowOpacity?: number;
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
