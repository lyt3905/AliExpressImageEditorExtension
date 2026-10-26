/**
 * Settings + volatile credentials.
 *
 * - chrome.storage.local  : non-secret settings (serverUrl, username) AND the
 *                           vision gateway config
 * - chrome.storage.session: in-memory credentials used for automatic re-login,
 *                           cleared by Chrome when the browser closes.
 *
 * Passwords are never written to chrome.storage.local and never logged.
 *
 * The vision API key DOES live in `local` — it has to survive a browser restart or
 * the compose panel would need it re-typed every morning. It points at a localhost
 * gateway, so the blast radius is a key that only works from this machine. It is
 * still never printed: errors from that client name the endpoint and the HTTP
 * status, never the key.
 */

import {
  DEFAULT_SERVER_URL,
  DEFAULT_VISION_BASE_URL,
  DEFAULT_VISION_MODEL,
  STORAGE_KEYS,
} from '../shared/constants';

export interface VisionSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ExtensionSettings {
  serverUrl: string;
  username: string;
  vision: VisionSettings;
}

export interface SessionCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

const DEFAULT_VISION: VisionSettings = {
  baseUrl: DEFAULT_VISION_BASE_URL,
  model: DEFAULT_VISION_MODEL,
  apiKey: '',
};

const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: DEFAULT_SERVER_URL,
  username: '',
  vision: { ...DEFAULT_VISION },
};

function normalizeVision(value: Partial<VisionSettings> | undefined): VisionSettings {
  return {
    baseUrl: value?.baseUrl?.trim() || DEFAULT_VISION.baseUrl,
    model: value?.model?.trim() || DEFAULT_VISION.model,
    apiKey: value?.apiKey?.trim() ?? DEFAULT_VISION.apiKey,
  };
}

export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const value = stored?.[STORAGE_KEYS.settings] as
      | (Partial<Omit<ExtensionSettings, 'vision'>> & { vision?: Partial<VisionSettings> })
      | undefined;
    return {
      serverUrl: value?.serverUrl?.trim() || DEFAULT_SETTINGS.serverUrl,
      username: value?.username?.trim() || '',
      vision: normalizeVision(value?.vision),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, vision: { ...DEFAULT_VISION } };
  }
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const next: ExtensionSettings = {
    serverUrl: settings.serverUrl?.trim() || current.serverUrl,
    username: settings.username?.trim() ?? current.username,
    // Merged field by field: the Options page may save only the vision block, and a
    // wholesale replace would silently blank the server URL.
    vision: settings.vision
      ? normalizeVision({ ...current.vision, ...settings.vision })
      : current.vision,
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
