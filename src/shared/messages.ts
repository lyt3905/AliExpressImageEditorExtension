/**
 * The single source of truth for cross-context messaging.
 *
 * Three channels exist in this extension:
 *   - action click  -> service worker (see service-worker.ts)
 *   - editor/options -> service worker (CREATE_EDITOR_SESSION, DOWNLOAD_COMPOSITE, ...)
 *   - service worker -> content script (SCAN_ACTIVE_TAB)
 *
 * Never pass a Blob through chrome messaging: it is JSON-serialised. Use data URLs.
 */

import type { ExportInput, SessionInput } from './types';

export type MessageType =
  | 'SCAN_ACTIVE_TAB'
  | 'CREATE_EDITOR_SESSION'
  | 'DOWNLOAD_COMPOSITE'
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
