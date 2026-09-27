/**
 * Service worker: orchestration only.
 *
 *   action click
 *     -> active AliExpress tab
 *     -> content script scan
 *     -> bounded-concurrency download
 *     -> IndexedDB blobs + session record
 *     -> open editor tab
 *
 * Cutout happens in the editor tab, never here, so the worker can be
 * terminated at any time without losing work.
 */

import { EXTENSION_TITLE, IMAGE_DOWNLOAD_CONCURRENCY } from '../shared/constants';
import { AppError, ErrorCode, messageOf, toAppError, type ErrorCodeValue } from '../shared/errors';
import { createRequestId, sendToTab, type ExtensionMessage, type MessageResponse } from '../shared/messages';
import type { ScannedImage, SessionImage } from '../shared/types';
import { evaluatePageGate } from '../shared/page-gate';
import { downloadImageBlob, runWithConcurrency } from './download-manager';
import { registerMessageRouter, type MessageHandlers } from './message-router';
import { buildSessionRecord, createSessionId, openEditorTab, saveSessionMeta } from './session-manager';
import { putBlob, putSession } from '../services/indexed-db';
import { downloadDataUrl } from '../services/downloader';
import { ServerApi, type AuthUser } from '../services/server-api';
import { clearCredentials, loadCredentials, loadSettings, saveCredentials, saveSettings } from '../services/settings';

const LAST_ERROR_KEY = 'aiee:last-error';

// ---------------------------------------------------------------- badge feedback

async function setBadge(text: string, title: string, color = '#1a73e8'): Promise<void> {
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setTitle({ title });
  } catch {
    /* badge errors are never fatal */
  }
}

async function reportFailure(error: unknown): Promise<void> {
  const appError = toAppError(error, '处理失败');
  await setBadge('!', `${EXTENSION_TITLE}：${appError.message}`, '#d93025');
  try {
    await chrome.storage.local.set({
      [LAST_ERROR_KEY]: { code: appError.code, message: appError.message, at: Date.now() },
    });
  } catch {
    /* ignore */
  }
  console.error('[AIEE]', appError.code, appError.message);
}

// ---------------------------------------------------------------- content script bridge

async function ensureContentScript(tabId: number): Promise<void> {
  const ping: ExtensionMessage = { type: 'PING', requestId: createRequestId('ping') };
  try {
    const response = await sendToTab<unknown>(tabId, ping);
    if (response?.ok) return;
  } catch {
    /* not injected yet — fall through */
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content-script.js'] });
  } catch (error) {
    throw new AppError(ErrorCode.CONTENT_SCRIPT_UNAVAILABLE, `无法注入内容脚本：${messageOf(error)}`);
  }
}

async function scanTab(tabId: number): Promise<{ images: ScannedImage[]; strategy: string }> {
  await ensureContentScript(tabId);
  const message: ExtensionMessage = { type: 'SCAN_ACTIVE_TAB', requestId: createRequestId('scan') };

  let response: MessageResponse<{ images: ScannedImage[]; strategy: string }>;
  try {
    response = await sendToTab<{ images: ScannedImage[]; strategy: string }>(tabId, message);
  } catch (error) {
    throw new AppError(ErrorCode.CONTENT_SCRIPT_UNAVAILABLE, `内容脚本无响应：${messageOf(error)}`);
  }
  if (!response?.ok || !response.data) {
    const code = (response?.error?.code as ErrorCodeValue | undefined) ?? ErrorCode.UNKNOWN;
    throw new AppError(code, response?.error?.message ?? '扫描失败');
  }
  return response.data;
}

// ---------------------------------------------------------------- main flow

export async function runScanFlow(tab: chrome.tabs.Tab): Promise<void> {
  const tabId = tab.id;

  if (typeof tabId !== 'number') throw new AppError(ErrorCode.NO_ACTIVE_TAB, '找不到当前标签页');

  const gate = evaluatePageGate(tab.url);
  if (!gate.ok) {
    // Log the offending URL: the badge can only show one short line, and
    // without the raw value a rejection like this is undebuggable.
    console.warn('[AIEE] page gate rejected', gate.reason, gate.rawUrl || '(无地址)');
    throw new AppError(ErrorCode.UNSUPPORTED_PAGE, gate.message);
  }

  const tabUrl = gate.url.href;

  await setBadge('…', `${EXTENSION_TITLE}：正在扫描商品主图…`);

  const { images, strategy } = await scanTab(tabId);
  console.log('[AIEE] scanned', images.length, 'images via', strategy);

  await setBadge('…', `${EXTENSION_TITLE}：正在下载 ${images.length} 张图片…`);

  const downloaded = await runWithConcurrency(images, IMAGE_DOWNLOAD_CONCURRENCY, async (image) => ({
    image,
    result: await downloadImageBlob(image.url),
  }));

  const sessionImages: SessionImage[] = [];
  const failures: string[] = [];

  for (const entry of downloaded) {
    if (!entry.ok) {
      failures.push(entry.error.message);
      continue;
    }
    const { image, result } = entry.value;
    const blobId = `blob-${image.id}`;
    try {
      await putBlob(blobId, result.blob);
    } catch (error) {
      failures.push(messageOf(error));
      continue;
    }
    sessionImages.push({
      id: image.id,
      index: image.index,
      blobId,
      url: image.url,
      width: result.width || image.width,
      height: result.height || image.height,
      // Page slot label (商品正面图 …) so the editor can tell the five apart.
      ...(image.label ? { label: image.label } : {}),
      // v1: every scanned main image is selected by default.
      selected: true,
      cutoutStatus: 'idle',
    });
  }

  if (sessionImages.length === 0) {
    throw new AppError(ErrorCode.NO_IMAGES, `未能下载任何商品主图${failures.length ? `（${failures[0]}）` : ''}`);
  }

  const sessionId = createSessionId();
  const record = buildSessionRecord({ id: sessionId, sourceTabId: tabId, sourceUrl: tabUrl, images: sessionImages });
  await putSession(record);
  await saveSessionMeta({
    id: record.id,
    createdAt: record.createdAt,
    sourceTabId: record.sourceTabId,
    sourceUrl: record.sourceUrl,
    imageIds: record.imageIds,
  });

  await openEditorTab(sessionId);
  await setBadge('', `${EXTENSION_TITLE}：已下载 ${sessionImages.length} 张图片`);
}

// ---------------------------------------------------------------- message handlers

const handlers: MessageHandlers = {
  /**
   * Persist a caller-provided session (blobs must already be in IndexedDB) and
   * open the editor for it.
   */
  async createEditorSession(payload) {
    if (!payload?.images?.length) {
      throw new AppError(ErrorCode.NO_IMAGES, '会话缺少图片数据');
    }
    const sessionId = createSessionId();
    const record = buildSessionRecord({
      id: sessionId,
      sourceTabId: payload.sourceTabId,
      sourceUrl: payload.sourceUrl,
      images: payload.images,
    });
    await putSession(record);
    await saveSessionMeta({
      id: record.id,
      createdAt: record.createdAt,
      sourceTabId: record.sourceTabId,
      sourceUrl: record.sourceUrl,
      imageIds: record.imageIds,
    });
    await openEditorTab(sessionId);
    return { sessionId };
  },

  async downloadComposite(payload) {
    const downloadId = await downloadDataUrl(payload.dataUrl, payload.filename);
    return { downloadId, filename: payload.filename };
  },

  getSettings() {
    return loadSettings();
  },

  async saveSettings(payload) {
    const next = await saveSettings({ serverUrl: payload.serverUrl, username: payload.username });
    if (payload.password) {
      await saveCredentials({ serverUrl: next.serverUrl, username: next.username, password: payload.password });
    }
    return next;
  },

  async getAuthState() {
    const settings = await loadSettings();
    const api = new ServerApi(settings.serverUrl);
    const user = await api.currentUser().catch(() => null);
    return { loggedIn: Boolean(user), user };
  },

  async login(payload) {
    const api = new ServerApi(payload.serverUrl);
    const user: AuthUser = await api.login(payload.username, payload.password);
    // Settings are persisted; the password only lives in chrome.storage.session.
    await saveSettings({ serverUrl: payload.serverUrl, username: payload.username });
    await saveCredentials({ serverUrl: payload.serverUrl, username: payload.username, password: payload.password });
    return user;
  },

  async logout() {
    const settings = await loadSettings();
    await new ServerApi(settings.serverUrl).logout();
    await clearCredentials();
    return { loggedIn: false } as const;
  },
};

// ---------------------------------------------------------------- wiring

chrome.action.onClicked.addListener((tab) => {
  void runScanFlow(tab).catch((error) => reportFailure(error));
});

registerMessageRouter(handlers);

chrome.runtime.onInstalled.addListener(() => {
  void setBadge('', EXTENSION_TITLE);
  void loadCredentials(); // warm the volatile credential cache path
});
