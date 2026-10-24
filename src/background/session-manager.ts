/**
 * Editor session management.
 *
 * Lightweight metadata lives in `chrome.storage.session`; the full record
 * (including per-image cutout status) lives in IndexedDB so the editor survives
 * a refresh and the service worker never has to keep state in memory.
 */

import { STORAGE_KEYS } from '../shared/constants';
import { AppError, ErrorCode } from '../shared/errors';
import type { EditorSessionMeta, EditorSessionRecord, SessionImage } from '../shared/types';

export function createSessionId(): string {
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildSessionRecord(input: {
  id: string;
  sourceTabId: number;
  sourceUrl: string;
  images: SessionImage[];
  productCode?: string | null;
  productTitle?: string | null;
}): EditorSessionRecord {
  return {
    id: input.id,
    createdAt: Date.now(),
    sourceTabId: input.sourceTabId,
    sourceUrl: input.sourceUrl,
    imageIds: input.images.map((image) => image.id),
    images: input.images,
    ...(input.productCode ? { productCode: input.productCode } : {}),
    ...(input.productTitle ? { productTitle: input.productTitle } : {}),
  };
}

export async function saveSessionMeta(meta: EditorSessionMeta): Promise<void> {
  await chrome.storage.session.set({ [`${STORAGE_KEYS.sessionPrefix}${meta.id}`]: meta });
}

export async function readSessionMeta(sessionId: string): Promise<EditorSessionMeta | null> {
  const key = `${STORAGE_KEYS.sessionPrefix}${sessionId}`;
  const stored = await chrome.storage.session.get(key);
  return (stored?.[key] as EditorSessionMeta | undefined) ?? null;
}

export function editorUrlFor(sessionId: string): string {
  return chrome.runtime.getURL(`editor/index.html?session=${encodeURIComponent(sessionId)}`);
}

export async function openEditorTab(sessionId: string): Promise<chrome.tabs.Tab> {
  try {
    return await chrome.tabs.create({ url: editorUrlFor(sessionId), active: true });
  } catch (error) {
    throw new AppError(
      ErrorCode.SESSION_NOT_FOUND,
      `无法打开编辑器页面：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
