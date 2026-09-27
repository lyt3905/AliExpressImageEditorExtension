/**
 * Watermark frame storage.
 *
 * Image payloads live in the shared IndexedDB `blobs` store (id prefix
 * `watermark-`), metadata lives in `chrome.storage.local`. The Options page and
 * the editor are both extension pages on the same origin, so they read and write
 * this directly — no new message type, no service-worker involvement, and the
 * DB schema stays at version 1.
 */

import {
  MAX_WATERMARK_BYTES,
  STORAGE_KEYS,
  WATERMARK_BLOB_PREFIX,
  WATERMARK_MIME_TYPES,
} from '../shared/constants';
import { AppError, ErrorCode, messageOf } from '../shared/errors';
import type { WatermarkMeta } from '../shared/types';
import { deleteBlob, getBlob, putBlob } from './indexed-db';
import { readBlobSize } from './image-size';

export function isSupportedWatermarkType(type: string): boolean {
  if (!type) return true; // the extension already restricts the file picker
  return (WATERMARK_MIME_TYPES as readonly string[]).includes(type);
}

function createWatermarkId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `${WATERMARK_BLOB_PREFIX}${Date.now().toString(36)}-${random}`;
}

function isWatermarkMeta(value: unknown): value is WatermarkMeta {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<WatermarkMeta>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.blobId === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.width === 'number' &&
    typeof candidate.height === 'number'
  );
}

/** All configured watermarks, oldest first. Never throws. */
export async function listWatermarks(): Promise<WatermarkMeta[]> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.watermarks);
    const value = stored?.[STORAGE_KEYS.watermarks] as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter(isWatermarkMeta)
      .map((entry) => ({ ...entry, isDefault: entry.isDefault === true }))
      .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0));
  } catch {
    return [];
  }
}

async function writeWatermarks(list: WatermarkMeta[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.watermarks]: list });
}

/**
 * Store a new watermark frame. The very first one becomes the default
 * automatically, so a single-watermark setup needs no extra click.
 */
export async function saveWatermark(file: Blob, name: string): Promise<WatermarkMeta> {
  if (!file || file.size === 0) {
    throw new AppError(ErrorCode.UNKNOWN, '水印图片为空，请换一张');
  }
  if (file.size > MAX_WATERMARK_BYTES) {
    const limit = Math.round(MAX_WATERMARK_BYTES / 1024 / 1024);
    throw new AppError(ErrorCode.UNKNOWN, `水印图片过大（上限 ${limit}MB，当前 ${(file.size / 1024 / 1024).toFixed(1)}MB）`);
  }
  if (!isSupportedWatermarkType(file.type)) {
    throw new AppError(ErrorCode.UNKNOWN, `不支持的水印格式：${file.type}，请使用 PNG / JPEG / WebP`);
  }

  const size = await readBlobSize(file);
  if (size.width <= 0 || size.height <= 0) {
    throw new AppError(ErrorCode.UNKNOWN, '无法解析水印图片尺寸，请换一张');
  }

  const list = await listWatermarks();
  const id = createWatermarkId();
  const meta: WatermarkMeta = {
    id,
    name: name.trim() || `水印 ${list.length + 1}`,
    blobId: id,
    width: size.width,
    height: size.height,
    isDefault: list.length === 0,
    createdAt: Date.now(),
  };

  try {
    await putBlob(id, file);
  } catch (error) {
    throw new AppError(ErrorCode.STORE_FAILED, `保存水印图片失败：${messageOf(error)}`);
  }
  await writeWatermarks([...list, meta]);
  return meta;
}

export async function renameWatermark(id: string, name: string): Promise<WatermarkMeta[]> {
  const list = await listWatermarks();
  const next = list.map((entry) => (entry.id === id ? { ...entry, name: name.trim() || entry.name } : entry));
  await writeWatermarks(next);
  return next;
}

/** Exactly one default at a time. */
export async function setDefaultWatermark(id: string): Promise<WatermarkMeta[]> {
  const list = await listWatermarks();
  const next = list.map((entry) => ({ ...entry, isDefault: entry.id === id }));
  await writeWatermarks(next);
  return next;
}

/** Remove a watermark and its blob. Promotes the first remaining one if needed. */
export async function removeWatermark(id: string): Promise<WatermarkMeta[]> {
  const list = await listWatermarks();
  const target = list.find((entry) => entry.id === id);
  const next = list.filter((entry) => entry.id !== id);

  if (target?.isDefault && next.length > 0 && !next.some((entry) => entry.isDefault) && next[0]) {
    next[0] = { ...next[0], isDefault: true };
  }

  await writeWatermarks(next);
  if (target) {
    // A leftover blob is harmless: it is never referenced again.
    await deleteBlob(target.blobId).catch(() => undefined);
  }
  return next;
}

/** The watermark the editor applies on open. */
export async function getDefaultWatermark(): Promise<WatermarkMeta | null> {
  const list = await listWatermarks();
  return list.find((entry) => entry.isDefault) ?? list[0] ?? null;
}

export async function loadWatermarkBlob(meta: WatermarkMeta): Promise<Blob | null> {
  return getBlob(meta.blobId).catch(() => null);
}
