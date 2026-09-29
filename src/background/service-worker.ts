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
import { closeEditorTabs } from './editor-tab';
import { registerMessageRouter, type MessageHandlers } from './message-router';
import { fillPageImage } from './page-filler';
import { buildSessionRecord, createSessionId, openEditorTab, readSessionMeta, saveSessionMeta } from './session-manager';
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
      // Keep the seller console's own slot number alongside it: it is the only
      // stable slot identity, and it is what a filled image would be offered
      // back to.
      ...(image.slotIndex !== undefined ? { slotIndex: image.slotIndex } : {}),
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

  /**
   * Put the composed PNG back into the product form.
   *
   * The session record is the only place the source tab is remembered, so an
   * expired session is reported as such instead of being guessed at. Failures
   * also land on the toolbar badge: the flow deliberately brings the product
   * page to the front, so the editor's status bar may not be visible when the
   * result comes back.
   */
  async replacePageImage(payload) {
    const meta = await readSessionMeta(payload.sessionId);
    if (!meta) {
      throw new AppError(ErrorCode.SESSION_NOT_FOUND, '会话已过期，请从商品页重新点击插件图标进入编辑器');
    }

    await setBadge('…', `${EXTENSION_TITLE}：正在把图片回填到商品页…`);
    try {
      const result = await fillPageImage(payload, meta);
      await setBadge(
        result.status === 'success' ? '' : '!',
        `${EXTENSION_TITLE}：${result.message}`,
        result.status === 'success' ? '#1a73e8' : '#f9ab00',
      );
      return result;
    } catch (error) {
      await reportFailure(error);
      throw error;
    }
  },

  /**
   * Close the editor tab that has finished its fill.
   *
   * Sent by the editor itself as the fallback half of its auto-close, i.e. only
   * when the page is somehow still alive after asking to close. By then the user
   * has already been told the fill finished, so this stays silent: no badge, no
   * error report — a tab that refuses to close is not news worth interrupting
   * for. See `editor-tab.ts` for why a tab id is never accepted.
   */
  async closeEditorTab(payload) {
    const closed = await closeEditorTabs(payload.sessionId);
    return { closed };
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

// Printed so the running build can be identified from the service worker's own
// console. An extension can be reloaded from chrome://extensions far less often
// than it is rebuilt, and "which version is live" is then the first question.
try {
  console.log(
    `[AIEE] service worker 已启动：v${chrome.runtime.getManifest().version}` +
      '（若与 chrome://extensions 上显示的版本号不同，说明这份扩展还没重新加载）',
  );
} catch {
  /* 版本号只用于诊断，读不到也不影响扩展 */
}

chrome.runtime.onInstalled.addListener(() => {
  void setBadge('', EXTENSION_TITLE);
  void loadCredentials(); // warm the volatile credential cache path
});
