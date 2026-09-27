/**
 * Extension settings + volatile credentials.
 *
 * - chrome.storage.local  : non-secret settings (serverUrl, username)
 * - chrome.storage.session: in-memory credentials used for automatic re-login,
 *                           cleared by Chrome when the browser closes.
 *
 * Passwords are never written to chrome.storage.local and never logged.
 */

import { DEFAULT_SERVER_URL, STORAGE_KEYS } from '../shared/constants';

export interface ExtensionSettings {
  serverUrl: string;
  username: string;
}

export interface SessionCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

const DEFAULT_SETTINGS: ExtensionSettings = { serverUrl: DEFAULT_SERVER_URL, username: '' };

export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const value = stored?.[STORAGE_KEYS.settings] as Partial<ExtensionSettings> | undefined;
    return {
      serverUrl: value?.serverUrl?.trim() || DEFAULT_SETTINGS.serverUrl,
      username: value?.username?.trim() || '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const next: ExtensionSettings = {
    serverUrl: settings.serverUrl?.trim() || current.serverUrl,
    username: settings.username?.trim() ?? current.username,
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function loadCredentials(): Promise<SessionCredentials | null> {
  try {
    const stored = await chrome.storage.session.get(STORAGE_KEYS.credentials);
    const value = stored?.[STORAGE_KEYS.credentials] as Partial<SessionCredentials> | undefined;
    if (!value?.serverUrl || !value.username || !value.password) return null;
    return { serverUrl: value.serverUrl, username: value.username, password: value.password };
  } catch {
    return null;
  }
}

export async function saveCredentials(credentials: SessionCredentials): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.credentials]: credentials });
  } catch {
    // Non fatal: auto re-login simply will not be available.
  }
}

export async function clearCredentials(): Promise<void> {
  try {
    await chrome.storage.session.remove(STORAGE_KEYS.credentials);
  } catch {
    /* ignore */
  }
}
