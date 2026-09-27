/**
 * IndexedDB access layer.
 *
 * Two object stores:
 *   blobs  — image payloads (original + cutout), keyed by blobId
 *   images — session records, keyed by sessionId, with a sessionId index
 *
 * No TTL / GC / migrations in v1 — the DB version is bumped only if the schema changes.
 */

import { DB_NAME, DB_VERSION, STORE_BLOBS, STORE_IMAGES } from '../shared/constants';
import { AppError, ErrorCode, messageOf } from '../shared/errors';
import type { EditorSessionRecord } from '../shared/types';

export interface StoredBlob {
  id: string;
  blob: Blob;
  mimeType: string;
  createdAt: number;
}

export interface StoredSessionRecord {
  sessionId: string;
  record: EditorSessionRecord;
  updatedAt: number;
}

export type IdbFactoryLike = Pick<IDBFactory, 'open'>;

function promisify<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

function resolveFactory(factory?: IdbFactoryLike): IdbFactoryLike {
  const candidate = factory ?? (globalThis.indexedDB as IdbFactoryLike | undefined);
  if (!candidate) throw new AppError(ErrorCode.STORE_FAILED, '当前环境不支持 IndexedDB');
  return candidate;
}

let cachedDb: IDBDatabase | null = null;

export function openDatabase(factory?: IdbFactoryLike, name = DB_NAME): Promise<IDBDatabase> {
  if (cachedDb && cachedDb.name === name) return Promise.resolve(cachedDb);

  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = resolveFactory(factory).open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_BLOBS)) {
        db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        const store = db.createObjectStore(STORE_IMAGES, { keyPath: 'sessionId' });
        store.createIndex('updatedAt', 'updatedAt');
      }
    };
    request.onsuccess = () => {
      cachedDb = request.result;
      cachedDb.onclose = () => {
        cachedDb = null;
      };
      resolve(cachedDb);
    };
    request.onerror = () => reject(request.error ?? new Error('无法打开 IndexedDB'));
  });
}

/** Test helper: drop the cached connection so a fresh factory can be used. */
export function resetDatabaseCache(): void {
  if (cachedDb) {
    try {
      cachedDb.close();
    } catch {
      /* ignore */
    }
  }
  cachedDb = null;
}

// ---------------------------------------------------------------- blobs

export async function putBlob(id: string, blob: Blob, factory?: IdbFactoryLike): Promise<StoredBlob> {
  const record: StoredBlob = { id, blob, mimeType: blob.type || 'application/octet-stream', createdAt: Date.now() };
  try {
    const db = await openDatabase(factory);
    const tx = db.transaction(STORE_BLOBS, 'readwrite');
    tx.objectStore(STORE_BLOBS).put(record);
    await transactionDone(tx);
    return record;
  } catch (error) {
    throw new AppError(ErrorCode.STORE_FAILED, `保存图片数据失败：${messageOf(error)}`);
  }
}

export async function getBlob(id: string, factory?: IdbFactoryLike): Promise<Blob | null> {
  try {
    const db = await openDatabase(factory);
    const tx = db.transaction(STORE_BLOBS, 'readonly');
    const result = await promisify<StoredBlob | undefined>(tx.objectStore(STORE_BLOBS).get(id));
    await transactionDone(tx);
    return result?.blob ?? null;
  } catch (error) {
    throw new AppError(ErrorCode.STORE_FAILED, `读取图片数据失败：${messageOf(error)}`);
  }
}

export async function deleteBlob(id: string, factory?: IdbFactoryLike): Promise<void> {
  const db = await openDatabase(factory);
  const tx = db.transaction(STORE_BLOBS, 'readwrite');
  tx.objectStore(STORE_BLOBS).delete(id);
  await transactionDone(tx);
}

// ---------------------------------------------------------------- sessions

export async function putSession(record: EditorSessionRecord, factory?: IdbFactoryLike): Promise<void> {
  try {
    const db = await openDatabase(factory);
    const tx = db.transaction(STORE_IMAGES, 'readwrite');
    tx.objectStore(STORE_IMAGES).put({ sessionId: record.id, record, updatedAt: Date.now() } satisfies StoredSessionRecord);
    await transactionDone(tx);
  } catch (error) {
    throw new AppError(ErrorCode.STORE_FAILED, `保存会话失败：${messageOf(error)}`);
  }
}

export async function getSession(sessionId: string, factory?: IdbFactoryLike): Promise<EditorSessionRecord | null> {
  try {
    const db = await openDatabase(factory);
    const tx = db.transaction(STORE_IMAGES, 'readonly');
    const result = await promisify<StoredSessionRecord | undefined>(tx.objectStore(STORE_IMAGES).get(sessionId));
    await transactionDone(tx);
    return result?.record ?? null;
  } catch (error) {
    throw new AppError(ErrorCode.STORE_FAILED, `读取会话失败：${messageOf(error)}`);
  }
}

/** Patch a single image inside a session and persist it. */
export async function patchSessionImage(
  sessionId: string,
  imageId: string,
  patch: Partial<import('../shared/types').SessionImage>,
  factory?: IdbFactoryLike,
): Promise<EditorSessionRecord | null> {
  const record = await getSession(sessionId, factory);
  if (!record) return null;
  const images = record.images.map((image) => (image.id === imageId ? { ...image, ...patch } : image));
  const next: EditorSessionRecord = { ...record, images };
  await putSession(next, factory);
  return next;
}

// ---------------------------------------------------------------- test helpers

export async function clearAll(factory?: IdbFactoryLike): Promise<void> {
  const db = await openDatabase(factory);
  const tx = db.transaction([STORE_BLOBS, STORE_IMAGES], 'readwrite');
  tx.objectStore(STORE_BLOBS).clear();
  tx.objectStore(STORE_IMAGES).clear();
  await transactionDone(tx);
}
