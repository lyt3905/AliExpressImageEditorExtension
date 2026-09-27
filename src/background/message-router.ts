/**
 * Single message router for the service worker.
 *
 * Every handler returns plain data; the router wraps it into the standard
 * MessageResponse envelope and never lets an exception escape into Chrome.
 */

import { ErrorCode, toAppError } from '../shared/errors';
import { errorResponse, okResponse, type ExtensionMessage, type MessageResponse } from '../shared/messages';
import type { ExportInput, SessionInput } from '../shared/types';
import type { AuthUser } from '../services/server-api';
import type { ExtensionSettings } from '../services/settings';

export interface MessageHandlers {
  createEditorSession(payload: SessionInput): Promise<{ sessionId: string }>;
  downloadComposite(payload: ExportInput): Promise<{ downloadId: number; filename: string }>;
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
    GET_SETTINGS: () => handlers.getSettings(),
    SAVE_SETTINGS: (message) => handlers.saveSettings((message as { payload: { serverUrl: string; username: string; password?: string } }).payload),
    GET_AUTH_STATE: () => handlers.getAuthState(),
    LOGIN: (message) => handlers.login((message as { payload: { serverUrl: string; username: string; password: string } }).payload),
    LOGOUT: () => handlers.logout(),
    PING: async () => 'pong',
  };
}

/** Dispatch one message. Exported for unit tests / reuse. */
export async function dispatchMessage(message: ExtensionMessage, handlers: MessageHandlers): Promise<MessageResponse<unknown>> {
  const route = buildRoutes(handlers)[message.type];
  if (!route) {
    return errorResponse(message.requestId, ErrorCode.UNKNOWN, `未知消息类型：${message.type}`);
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

    void dispatchMessage(candidate, handlers).then(sendResponse);
    return true; // keep the channel open for the async response
  });
}
