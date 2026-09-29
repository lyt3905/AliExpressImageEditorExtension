/**
 * Single message router for the service worker.
 *
 * Every handler returns plain data; the router wraps it into the standard
 * MessageResponse envelope and never lets an exception escape into Chrome.
 */

import { ErrorCode, toAppError } from '../shared/errors';
import { errorResponse, okResponse, type ExtensionMessage, type MessageResponse } from '../shared/messages';
import type { ExportInput, PageFillInput, PageFillResult, SessionInput } from '../shared/types';
import type { AuthUser } from '../services/server-api';
import type { ExtensionSettings } from '../services/settings';

export interface MessageHandlers {
  createEditorSession(payload: SessionInput): Promise<{ sessionId: string }>;
  downloadComposite(payload: ExportInput): Promise<{ downloadId: number; filename: string }>;
  replacePageImage(payload: PageFillInput): Promise<PageFillResult>;
  closeEditorTab(payload: { sessionId: string }): Promise<{ closed: number }>;
  getSettings(): Promise<ExtensionSettings>;
  saveSettings(payload: { serverUrl: string; username: string; password?: string }): Promise<ExtensionSettings>;
  getAuthState(): Promise<{ loggedIn: boolean; user: AuthUser | null }>;
  login(payload: { serverUrl: string; username: string; password: string }): Promise<AuthUser>;
  logout(): Promise<{ loggedIn: false }>;
}

type Handler = (message: ExtensionMessage) => Promise<unknown>;

function buildRoutes(handlers: MessageHandlers): Record<string, Handler> {
  return {
    SCAN_ACTIVE_TAB: async () => {
      throw Object.assign(new Error('SCAN_ACTIVE_TAB 由 content script 处理'), {
        code: ErrorCode.CONTENT_SCRIPT_UNAVAILABLE,
      });
    },
    CREATE_EDITOR_SESSION: (message) => {
      const payload = (message as { payload: SessionInput }).payload;
      return handlers.createEditorSession(payload);
    },
    DOWNLOAD_COMPOSITE: (message) => {
      const payload = (message as { payload: ExportInput }).payload;
      return handlers.downloadComposite(payload);
    },
    REPLACE_PAGE_IMAGE: (message) => {
      const payload = (message as { payload: PageFillInput }).payload;
      return handlers.replacePageImage(payload);
    },
    CLOSE_EDITOR_TAB: (message) => {
      const payload = (message as { payload: { sessionId: string } }).payload;
      return handlers.closeEditorTab(payload);
    },
    GET_SETTINGS: () => handlers.getSettings(),
    SAVE_SETTINGS: (message) => handlers.saveSettings((message as { payload: { serverUrl: string; username: string; password?: string } }).payload),
    GET_AUTH_STATE: () => handlers.getAuthState(),
    LOGIN: (message) => handlers.login((message as { payload: { serverUrl: string; username: string; password: string } }).payload),
    LOGOUT: () => handlers.logout(),
    PING: async () => 'pong',
  };
}

/**
 * Version of the build that is actually answering.
 *
 * A message type can only be missing from the route table when the worker
 * replying is OLDER than its caller — the code on disk can be perfect and the
 * browser still be running an old service worker (MV3 does not hot-swap one).
 * That failure looks exactly like a typo in the message plumbing, so the error
 * names the running build: one line instead of an afternoon of guessing.
 */
function runningVersion(): string {
  try {
    const api = chrome as unknown as { runtime?: { getManifest?: () => { version?: string } } };
    return api.runtime?.getManifest?.()?.version ?? '未知';
  } catch {
    // No chrome API at all (unit tests run in node) — the message still has to
    // come out, so degrade to "unknown" rather than throwing inside the router.
    return '未知';
  }
}

function unknownTypeMessage(type: string, routeCount: number): string {
  return (
    `未知消息类型：${type}（正在运行的扩展版本 ${runningVersion()}，路由 ${routeCount} 条）` +
    '——如果这是刚构建好的功能，说明浏览器还在跑旧版本：请到 chrome://extensions 点刷新（⟳），再关掉本页重新从插件图标进入。'
  );
}

/** Dispatch one message. Exported for unit tests / reuse. */
export async function dispatchMessage(message: ExtensionMessage, handlers: MessageHandlers): Promise<MessageResponse<unknown>> {
  const routes = buildRoutes(handlers);
  const route = routes[message.type];
  if (!route) {
    return errorResponse(message.requestId, ErrorCode.UNKNOWN, unknownTypeMessage(message.type, Object.keys(routes).length));
  }
  try {
    const data = await route(message);
    return okResponse(message.requestId, data);
  } catch (error) {
    const appError = toAppError(error);
    const code = (error as { code?: string } | null)?.code ?? appError.code;
    return errorResponse(message.requestId, code, appError.message);
  }
}

export function registerMessageRouter(handlers: MessageHandlers): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    const candidate = message as ExtensionMessage;
    if (typeof candidate.type !== 'string' || typeof candidate.requestId !== 'string') return false;

    void dispatchMessage(candidate, handlers).then(
      (response) => {
        // The caller may be gone by the time its answer is ready. A page fill
        // runs for seconds and the editor now closes itself 10 s after starting
        // one, so answering a dead port is a normal outcome, not a bug — and an
        // unhandled rejection here would look like one in the worker's console.
        try {
          sendResponse(response);
        } catch {
          /* the caller's tab was closed while it waited */
        }
      },
      () => undefined, // dispatchMessage returns an error envelope instead of rejecting
    );
    return true; // keep the channel open for the async response
  });
}
