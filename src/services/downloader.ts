/**
 * File download helpers.
 *
 * `chrome.downloads` lives in the service worker, and Blobs cannot be sent over
 * chrome messaging (JSON serialisation), so the editor converts the PNG into a
 * data URL and the service worker downloads that.
 */

import { AppError, ErrorCode, messageOf } from '../shared/errors';

export async function downloadDataUrl(dataUrl: string, filename: string): Promise<number> {
  if (!dataUrl.startsWith('data:')) {
    throw new AppError(ErrorCode.UNKNOWN, '下载内容不是合法的 data URL');
  }
  try {
    const downloadId = await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false,
    });
    if (typeof downloadId !== 'number') throw new Error('chrome.downloads 未返回下载 ID');
    return downloadId;
  } catch (error) {
    throw new AppError(ErrorCode.UNKNOWN, `下载失败：${messageOf(error)}`);
  }
}

/** Fallback used from the editor page when the service worker path is unavailable. */
export async function downloadBlobInPage(blob: Blob, filename: string): Promise<void> {
  const url = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url, filename, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 20_000);
  }
}

export async function verifyDownload(downloadId: number): Promise<string | null> {
  try {
    const [item] = await chrome.downloads.search({ id: downloadId });
    return item?.filename ?? item?.url ?? null;
  } catch {
    return null;
  }
}
