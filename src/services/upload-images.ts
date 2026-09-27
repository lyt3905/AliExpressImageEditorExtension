/**
 * Local uploads (file picker / clipboard paste) turned into session images.
 *
 * IndexedDB — not the editor's in-memory material list — is the source of truth
 * for "which pictures belong to this session". `use-editor-session` rebuilds the
 * material list from the session record and then filters the stored layers with
 * `keepLayerWithMaterials`, so an image that only ever existed in memory would
 * take its layer down with it on the next refresh. Uploading therefore means:
 * write the blob, append a `SessionImage`, persist the record.
 *
 * Validation is per-file and never fatal: one oversized or non-image file must
 * not throw away the four good ones next to it.
 */

import { MAX_UPLOAD_BYTES } from '../shared/constants';
import { messageOf } from '../shared/errors';
import { SUPPORTED_IMAGE_MIME_HINT, resolveImageMime } from '../shared/image-mime';
import type { EditorSessionRecord, SessionImage } from '../shared/types';
import { putBlob, putSession } from './indexed-db';
import { readBlobSize } from './image-size';

/**
 * Blob-id and image-id prefix. Scanned images are keyed by a hash of their
 * normalised URL, so this can never collide with one.
 */
export const UPLOAD_ID_PREFIX = 'upload-';

/** Fallback label when the source has no file name (a raw screenshot paste). */
export const UPLOAD_DEFAULT_LABEL = '本地图片';

export interface UploadCandidate {
  /** File name, used for the layer label and rejection messages. */
  name: string;
  blob: Blob;
}

export interface UploadRejection {
  name: string;
  reason: string;
}

export interface UploadOutcome {
  /** The record to persist — `imageIds` already re-derived from `images`. */
  record: EditorSessionRecord;
  /** Images actually appended, in input order. */
  added: SessionImage[];
  /** Files that were skipped, in input order. */
  rejected: UploadRejection[];
}

const MAX_UPLOAD_MB = Math.round(MAX_UPLOAD_BYTES / 1024 / 1024);

/** Human-readable size for a rejection message. */
export function describeUploadSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * A fresh image id. Collisions are practically impossible, but the caller's
 * id set is checked anyway so a synthetic id can never shadow a real one.
 */
export function createUploadImageId(taken: ReadonlySet<string>): string {
  let id = '';
  do {
    id = `${UPLOAD_ID_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(id));
  return id;
}

/**
 * Append uploaded files to a session record and persist both the blobs and the
 * record. Successful images come back as `selected`, `idle` entries — the caller
 * is responsible for handing them to the cutout queue.
 */
export async function appendUploadedImages(
  record: EditorSessionRecord,
  candidates: readonly UploadCandidate[],
): Promise<UploadOutcome> {
  const added: SessionImage[] = [];
  const rejected: UploadRejection[] = [];
  const taken = new Set(record.images.map((image) => image.id));
  // Continue the page's numbering instead of restarting at 0.
  let nextIndex = record.images.reduce((max, image) => Math.max(max, image.index + 1), 0);

  for (const candidate of candidates) {
    const { name, blob } = candidate;

    if (!blob || blob.size === 0) {
      rejected.push({ name, reason: '文件为空' });
      continue;
    }
    if (blob.size > MAX_UPLOAD_BYTES) {
      rejected.push({ name, reason: `超过 ${MAX_UPLOAD_MB}MB 上限（当前 ${describeUploadSize(blob.size)}）` });
      continue;
    }

    // A screenshot paste often arrives with a blank or generic type, so the
    // bytes are sniffed before giving up (same rule as the download path).
    const mimeType = await resolveImageMime(blob);
    if (!mimeType) {
      rejected.push({ name, reason: `不是支持的图片格式（仅 ${SUPPORTED_IMAGE_MIME_HINT}）` });
      continue;
    }

    const size = await readBlobSize(blob);
    if (size.width <= 0 || size.height <= 0) {
      rejected.push({ name, reason: '无法解析图片尺寸' });
      continue;
    }

    const id = createUploadImageId(taken);
    taken.add(id);

    try {
      // Re-wrap only when sniffing disagreed with the declared type, so the
      // stored blob carries a real image mime onward to the cutout request.
      await putBlob(id, mimeType === blob.type ? blob : new Blob([blob], { type: mimeType }));
    } catch (error) {
      // A failed write leaves no orphan: nothing references the id yet.
      rejected.push({ name, reason: messageOf(error) });
      continue;
    }

    added.push({
      id,
      index: nextIndex,
      blobId: id,
      // A local file has no source page URL. Nothing reads this field back —
      // the editor renders from blobs via object URLs.
      url: '',
      width: size.width,
      height: size.height,
      label: name.trim() || UPLOAD_DEFAULT_LABEL,
      // Selected on purpose: the automatic pipeline only ever queues
      // `selected && idle`, so an unselected upload would sit there forever.
      selected: true,
      cutoutStatus: 'idle',
    });
    nextIndex += 1;
  }

  if (added.length === 0) return { record, added, rejected };

  const next: EditorSessionRecord = {
    ...record,
    images: [...record.images, ...added],
    // Re-derived rather than appended: this self-heals any drift between the two
    // arrays, and the same array is what `chrome.storage.session` reports.
    imageIds: [...record.images, ...added].map((image) => image.id),
  };

  await putSession(next);
  return { record: next, added, rejected };
}

/** One-line summary for the editor's notice bar. */
export function describeUploadOutcome(outcome: UploadOutcome): { kind: 'ok' | 'error'; text: string } {
  const { added, rejected } = outcome;
  const details = rejected.map((entry) => `${entry.name}（${entry.reason}）`).join('；');

  if (added.length === 0) {
    if (rejected.length === 0) return { kind: 'ok', text: '没有可添加的图片' };
    return { kind: 'error', text: `未能添加图片：${details}` };
  }

  const base = `已添加 ${added.length} 张图片，正在自动抠图`;
  if (rejected.length === 0) return { kind: 'ok', text: base };
  return { kind: 'error', text: `${base}；已跳过 ${rejected.length} 张：${details}` };
}
