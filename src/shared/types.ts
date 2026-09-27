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
  /**
   * The seller console's own slot number (`data-index` on `.sell-o-image-item`).
   * Scanned slots are sorted by it, so it is the only stable identity a slot
   * has — needed to offer a composed PNG back to the slot it came from.
   */
  slotIndex?: number;
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
  /** Seller-console slot number this image was scanned from (see ScannedImage). */
  slotIndex?: number;
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

// ---------------------------------------------------------------- page fill

/**
 * How the composed PNG is put back on the product page.
 *
 * `append` only ever ADDS a slot image. `replace-first` additionally deletes the
 * current first image first, which frees a slot when the product already has all
 * six in use — and, because AliExpress shifts the later images forward, the new
 * image then lands in the last slot rather than at position 1.
 *
 * Either way the composed PNG is never offered as a replacement for a specific
 * existing slot: nothing is swapped in place.
 */
export type PageFillMode = 'append' | 'replace-first';

/** Editor -> service worker. */
export interface PageFillInput {
  sessionId: string;
  /** 800x800 PNG as a data URL, same shape as `ExportInput`. */
  dataUrl: string;
  filename: string;
  /**
   * Delete the product's current FIRST image before uploading, freeing a slot on
   * a product that already uses all six. Destructive: the deleted image is only
   * recoverable by hand, and it is applied without a confirmation step of its own
   * (the editor's checkbox is the confirmation). Off by default at the type level
   * so a caller that forgets it never deletes anything.
   */
  removeFirstImage?: boolean;
}

/** One recorded step of the in-page flow. Mirrors the injected bridge's stages. */
export interface PageFillStageRecord {
  stage: string;
  stageLabel: string;
  status: 'ok' | 'notice' | 'failed';
  message: string;
  diagnostics?: unknown;
}

/**
 * Service worker -> injected bridge.
 *
 * `openPanel` is false on a cross-frame retry: the upload panel is already open
 * (it just lives in another frame), so clicking the upload button again would
 * close it.
 */
export interface PageFillRequest {
  dataUrl: string;
  fileMeta: { name: string; type: string; size: number };
  openPanel: boolean;
  /**
   * Delete the first image before doing anything else.
   *
   * Only ever true on the FIRST attempt: a cross-frame retry would delete the
   * second image, since the first one is already gone by then. The orchestrator
   * forces it to false on every retry.
   */
  removeFirstImage: boolean;
  /** Whether the bridge may click the panel's own 「确认上传」. Never the product-level save. */
  confirmUploadClick: boolean;
  panelTimeout: number;
  uploadTimeout: number;
  confirmTimeout: number;
  /** How long to wait for the delete icon, and then for the image to disappear. */
  deleteTimeout: number;
}

/** What the injected bridge answers with. */
export interface PageFillBridgeResult {
  ok: boolean;
  status: 'success' | 'unconfirmed' | 'failed';
  stage: string | null;
  code: string | null;
  message: string;
  stages: PageFillStageRecord[];
  elapsedMs: number;
  frameUrl: string;
  upload: { status: string; confirmed: boolean; strategy: string; criteria: string | null } | null;
  confirmUpload: {
    skipped: boolean;
    clicked: boolean;
    found: boolean;
    panelGone?: boolean;
    panelClosed?: boolean;
    buttonText: string | null;
  } | null;
}

/** Service worker -> editor: the bridge result plus which frame it ran in. */
export interface PageFillResult {
  status: PageFillBridgeResult['status'];
  stage: string | null;
  code: string | null;
  message: string;
  stages: PageFillStageRecord[];
  /**
   * Warnings the bridge recorded while still reporting success, e.g. "no empty
   * slot was found, so this may have overwritten an existing image".
   *
   * Kept separate from `message` so the editor can still style a successful run
   * as a success and put the caveat where it will actually be read; folding it
   * into the message risks the user skimming past it.
   */
  warnings: string[];
  elapsedMs: number;
  frameId: number;
  frameUrl: string;
  strategy: 'input' | 'drop-zone' | null;
  confirmed: boolean;
}
