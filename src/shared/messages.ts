/**
 * The single source of truth for cross-context messaging.
 *
 * Three channels exist in this extension:
 *   - action click  -> service worker (see service-worker.ts)
 *   - editor/options -> service worker (CREATE_EDITOR_SESSION, DOWNLOAD_COMPOSITE, ...)
 *   - service worker -> content script (SCAN_ACTIVE_TAB)
 *
 * Plus one separate channel, built to a different shape on purpose: the
 * service worker drives the page-fill bridge per frame (see the bottom of this
 * file).
 *
 * Never pass a Blob through chrome messaging: it is JSON-serialised. Use data URLs.
 */

import type { ExportInput, PageFillBridgeResult, PageFillInput, PageFillRequest, SessionInput } from './types';

export type MessageType =
  | 'SCAN_ACTIVE_TAB'
  | 'CREATE_EDITOR_SESSION'
  | 'DOWNLOAD_COMPOSITE'
  | 'REPLACE_PAGE_IMAGE'
  | 'CLOSE_EDITOR_TAB'
  | 'GET_SETTINGS'
  | 'SAVE_SETTINGS'
  | 'GET_AUTH_STATE'
  | 'LOGIN'
  | 'LOGOUT'
  | 'PING';

export interface ScanActiveTabMessage {
  type: 'SCAN_ACTIVE_TAB';
  requestId: string;
}

export interface CreateEditorSessionMessage {
  type: 'CREATE_EDITOR_SESSION';
  requestId: string;
  payload: SessionInput;
}

export interface DownloadCompositeMessage {
  type: 'DOWNLOAD_COMPOSITE';
  requestId: string;
  payload: ExportInput;
}

export interface ReplacePageImageMessage {
  type: 'REPLACE_PAGE_IMAGE';
  requestId: string;
  payload: PageFillInput;
}

/**
 * Editor -> service worker: "close my tab".
 *
 * Only ever sent by the editor itself, and only as the fallback half of the
 * auto-close (the primary path is the page's own `window.close()`). The session
 * id — not a tab id — is what travels: the background locates the tab by
 * matching its URL, so a stale or forged id can never close somebody else's tab.
 */
export interface CloseEditorTabMessage {
  type: 'CLOSE_EDITOR_TAB';
  requestId: string;
  payload: { sessionId: string };
}

export interface GetSettingsMessage {
  type: 'GET_SETTINGS';
  requestId: string;
}

export interface SaveSettingsMessage {
  type: 'SAVE_SETTINGS';
  requestId: string;
  payload: { serverUrl: string; username: string; password?: string };
}

export interface GetAuthStateMessage {
  type: 'GET_AUTH_STATE';
  requestId: string;
}

export interface LoginMessage {
  type: 'LOGIN';
  requestId: string;
  payload: { serverUrl: string; username: string; password: string };
}

export interface LogoutMessage {
  type: 'LOGOUT';
  requestId: string;
}

export interface PingMessage {
  type: 'PING';
  requestId: string;
}

export type ExtensionMessage =
  | ScanActiveTabMessage
  | CreateEditorSessionMessage
  | DownloadCompositeMessage
  | ReplacePageImageMessage
  | CloseEditorTabMessage
  | GetSettingsMessage
  | SaveSettingsMessage
  | GetAuthStateMessage
  | LoginMessage
  | LogoutMessage
  | PingMessage;

export interface MessageResponse<T = unknown> {
  requestId: string;
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

const MESSAGE_TYPES: ReadonlySet<string> = new Set<MessageType>([
  'SCAN_ACTIVE_TAB',
  'CREATE_EDITOR_SESSION',
  'DOWNLOAD_COMPOSITE',
  'REPLACE_PAGE_IMAGE',
  'CLOSE_EDITOR_TAB',
  'GET_SETTINGS',
  'SAVE_SETTINGS',
  'GET_AUTH_STATE',
  'LOGIN',
  'LOGOUT',
  'PING',
]);

export function createRequestId(prefix = 'req'): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { type?: unknown; requestId?: unknown };
  return typeof candidate.type === 'string' && MESSAGE_TYPES.has(candidate.type);
}

export function okResponse<T>(requestId: string, data: T): MessageResponse<T> {
  return { requestId, ok: true, data };
}

export function errorResponse(requestId: string, code: string, message: string): MessageResponse<never> {
  return { requestId, ok: false, error: { code, message } };
}

/** Send to the extension service worker and unwrap the response. */
export function sendToBackground<T>(message: ExtensionMessage): Promise<MessageResponse<T>> {
  return chrome.runtime.sendMessage(message) as Promise<MessageResponse<T>>;
}

/** Send to the content script of one tab and unwrap the response. */
export function sendToTab<T>(tabId: number, message: ExtensionMessage): Promise<MessageResponse<T>> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<MessageResponse<T>>;
}

// ---------------------------------------------------------------- page-fill bridge

/**
 * Background -> the page-fill bridge injected with `chrome.scripting.executeScript`.
 *
 * Deliberately NOT a member of `MessageType`. That union is the envelope the
 * declarative content script validates, and it always answers the *top* frame's
 * listener; the bridge is injected per-frame and has to be addressed by
 * `frameId`, so keeping the two channels apart stops one from ever being
 * mistaken for the other.
 */
export const PAGE_FILL_MESSAGE_TYPE = 'AIEE_PAGE_FILL_EXECUTE';

export interface PageFillMessage {
  type: typeof PAGE_FILL_MESSAGE_TYPE;
  requestId: string;
  payload: PageFillRequest;
}

export function isPageFillMessage(value: unknown): value is PageFillMessage {
  if (!value || typeof value !== 'object') return false;
  return (value as { type?: unknown }).type === PAGE_FILL_MESSAGE_TYPE;
}

/**
 * Send to the bridge in ONE frame.
 *
 * `sendToTab` cannot express this: without `frameId` Chrome delivers to every
 * frame in the tab and the promise settles with whichever replies first.
 */
export function sendToFrame(
  tabId: number,
  frameId: number,
  message: PageFillMessage,
): Promise<PageFillBridgeResult> {
  return chrome.tabs.sendMessage(tabId, message, { frameId }) as Promise<PageFillBridgeResult>;
}
