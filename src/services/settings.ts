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
  DEFAULT_VISION_API_KEY,
  DEFAULT_VISION_BASE_URL,
  DEFAULT_VISION_MODEL,
  MAX_VISION_ENDPOINTS,
  STORAGE_KEYS,
} from '../shared/constants';

/**
 * One gateway in the vision chain, as the Options page stores it.
 *
 * `model` / `apiKey` may be empty: an empty field means "use whatever the first
 * entry says", so a second gateway that only differs by address costs one line and
 * does not silently go out with a blank key. The inheritance is applied by
 * `resolveVisionConfigs()`, not here — stored rows keep what the user typed so the
 * inputs do not fill themselves in behind their back.
 */
export interface VisionEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
}

/**
 * A resolved single-endpoint config — exactly what one HTTP request needs.
 * Only `resolveVisionConfigs()` produces these; keep the two types apart so an
 * unresolved row cannot be passed to the client by mistake.
 */
export interface VisionSettings {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ExtensionSettings {
  serverUrl: string;
  username: string;
  /** Self-hosted / business-mirror URL for the brand catalog. Empty = built-in mirrors only. */
  brandCatalogUrl: string;
  /**
   * Ordered vision gateways; the first one that answers wins. Never empty — an
   * empty list normalises back to the built-in default gateway.
   */
  vision: VisionEndpoint[];
}

export interface SessionCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

const DEFAULT_VISION: VisionSettings = {
  baseUrl: DEFAULT_VISION_BASE_URL,
  model: DEFAULT_VISION_MODEL,
  // Comes from the gitignored `.env.local` at build time (see constants.ts), so the
  // Options page starts pre-filled on a developer's own build and empty in CI.
  apiKey: DEFAULT_VISION_API_KEY,
};

/**
 * The chain when nothing is stored: one entry, no overrides, so it resolves to
 * `DEFAULT_VISION` exactly like the old single-object setting did.
 */
const DEFAULT_VISION_ENDPOINTS: VisionEndpoint[] = [
  { baseUrl: DEFAULT_VISION.baseUrl, model: '', apiKey: '' },
];

const DEFAULT_SETTINGS: ExtensionSettings = {
  serverUrl: DEFAULT_SERVER_URL,
  username: '',
  brandCatalogUrl: '',
  vision: DEFAULT_VISION_ENDPOINTS.map((entry) => ({ ...entry })),
};

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Normalise the stored vision chain.
 *
 * Accepts three shapes on purpose:
 *   - the 10.8.x and earlier single object `{baseUrl, model, apiKey}` → one entry;
 *   - an array of entries (current);
 *   - anything else → the default chain.
 *
 * Rows without an address are dropped rather than kept as blanks: an endpoint
 * cannot be tried without one, and keeping it would make the Options page show a
 * row that claims to be part of the chain but never fires. Empty `model`/`apiKey`
 * are kept as written — they mean "inherit from the first entry", and filling them
 * in here would hide that from the user the next time they open the page.
 *
 * An empty `apiKey` used to fall back to the build-time default instead of staying
 * empty, and it still does — that resolution now happens in
 * `resolveVisionConfigs()`, so the stored value stays honest while every request
 * still carries a key. Reason it matters: one "仅保存设置" click taken before a key
 * existed would otherwise shadow every future default and every request would go
 * out unauthenticated (HTTP 401) while the field looked configured.
 */
function normalizeVisionEndpoints(value: unknown): VisionEndpoint[] {
  const raw: unknown[] = Array.isArray(value)
    ? value
    : value && typeof value === 'object'
      ? [value]
      : [];
  const entries: VisionEndpoint[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const baseUrl = readString(record.baseUrl);
    if (!baseUrl) continue;
    entries.push({ baseUrl, model: readString(record.model), apiKey: readString(record.apiKey) });
    if (entries.length >= MAX_VISION_ENDPOINTS) break;
  }
  return entries.length > 0 ? entries : DEFAULT_VISION_ENDPOINTS.map((entry) => ({ ...entry }));
}

export async function loadSettings(): Promise<ExtensionSettings> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
    const value = stored?.[STORAGE_KEYS.settings] as
      | (Partial<Omit<ExtensionSettings, 'vision'>> & { vision?: unknown })
      | undefined;
    return {
      serverUrl: value?.serverUrl?.trim() || DEFAULT_SETTINGS.serverUrl,
      username: value?.username?.trim() || '',
      // Not falling back to a default: an empty string is the meaningful value
      // ("use the built-in mirrors"). Kept as written; validity is checked where
      // it is used, not here.
      brandCatalogUrl: typeof value?.brandCatalogUrl === 'string' ? value.brandCatalogUrl.trim() : '',
      vision: normalizeVisionEndpoints(value?.vision),
    };
  } catch {
    return { ...DEFAULT_SETTINGS, vision: DEFAULT_VISION_ENDPOINTS.map((entry) => ({ ...entry })) };
  }
}

/**
 * Every field is optional. `vision` is normally the whole chain (a list replaces the
 * stored one — removing a gateway has to be expressible). A single object still
 * works: it patches the MAIN gateway field by field, which is what the editor does
 * when it only knows about one address, and what every caller written before the
 * chain existed sends.
 */
export type SettingsPatch = Partial<Omit<ExtensionSettings, 'vision'>> & {
  vision?: VisionEndpoint[] | Partial<VisionSettings>;
};

export async function saveSettings(settings: SettingsPatch): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const patchVision = settings.vision;
  const nextVision = Array.isArray(patchVision)
    ? normalizeVisionEndpoints(patchVision)
    : patchVision
      ? // Patch the first row, keep the backups: a caller that only saves one
        // address must not thereby delete the rest of the chain.
        normalizeVisionEndpoints([
          { ...current.vision[0], ...patchVision },
          ...current.vision.slice(1),
        ])
      : current.vision;
  const next: ExtensionSettings = {
    serverUrl: settings.serverUrl?.trim() || current.serverUrl,
    username: settings.username?.trim() ?? current.username,
    // `''` is a deliberate value here (clear the mirror), so only `undefined`
    // means "leave it alone" — the same reason username uses `??`, not `||`.
    brandCatalogUrl: settings.brandCatalogUrl?.trim() ?? current.brandCatalogUrl,
    // Omitted means "leave the chain alone": the Options page may save only the
    // vision block, and a wholesale replace would silently blank the server URL.
    vision: nextVision,
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
