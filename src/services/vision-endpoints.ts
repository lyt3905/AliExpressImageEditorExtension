/**
 * The vision chain: several gateways in order, the first one that answers wins.
 *
 * Why a chain at all: the gateway people actually use is a local one
 * (`127.0.0.1:8788`) that is simply not running sometimes — a laptop reboot, a
 * container left stopped. Falling back to a second address beats making the seller
 * notice, open the Options page and retype a URL.
 *
 * Rules, all of them deliberate:
 *  - every failure (unreachable / timeout / 401 / 5xx / unparseable body) moves on
 *    to the next gateway. Being picky about *why* it failed would mean a dead
 *    gateway with a stale key never lets the working one speak;
 *  - the gateway that answered is remembered and tried first next time, so a
 *    primary that is down costs one timeout once, not one per request;
 *  - if everything fails we rethrow the FIRST error, with the others appended to
 *    its message. The first entry is the one the user considers "the real
 *    gateway", so its status code is the one worth surfacing.
 */

import { DEFAULT_VISION_API_KEY, DEFAULT_VISION_MODEL, STORAGE_KEYS } from '../shared/constants';
import type { VisionEndpoint, VisionSettings } from './settings';
import {
  askVisionJson,
  VisionError,
  type FetchLike,
  type VisionAnswer,
  type VisionImageInput,
} from './vision-client';

/**
 * Turn stored rows into request configs.
 *
 * An empty `model` / `apiKey` on a row inherits from the FIRST row, which is the
 * one the Options page labels as the main gateway. So a backup gateway that only
 * differs by address needs just the address, while a gateway on a different model
 * can still state its own.
 */
export function resolveVisionConfigs(endpoints: readonly VisionEndpoint[]): VisionSettings[] {
  const base = endpoints[0];
  if (!base) return [];
  const inheritedModel = base.model || DEFAULT_VISION_MODEL;
  // Same reasoning as `normalizeVisionEndpoints`: an empty key means "use the
  // build-time default", never "send no Authorization header".
  const inheritedKey = base.apiKey || DEFAULT_VISION_API_KEY;
  return endpoints.map((endpoint) => ({
    baseUrl: endpoint.baseUrl,
    model: endpoint.model || inheritedModel,
    apiKey: endpoint.apiKey || inheritedKey,
  }));
}

export interface VisionPinPorts {
  loadPin?: () => Promise<string>;
  savePin?: (baseUrl: string) => Promise<void>;
}

async function loadPinnedBaseUrl(): Promise<string> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.visionPin);
    const value = stored?.[STORAGE_KEYS.visionPin];
    return typeof value === 'string' ? value : '';
  } catch {
    return '';
  }
}

async function savePinnedBaseUrl(baseUrl: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.visionPin]: baseUrl });
  } catch {
    // Non fatal: the pin is an optimisation, the chain works without it.
  }
}

/** Move the pinned gateway to the front, leaving the rest in stored order. */
export function orderByPin(
  configs: readonly VisionSettings[],
  pinnedBaseUrl: string,
): VisionSettings[] {
  if (!pinnedBaseUrl) return [...configs];
  const pinned = configs.filter((config) => config.baseUrl === pinnedBaseUrl);
  if (pinned.length === 0) return [...configs];
  return [...pinned, ...configs.filter((config) => config.baseUrl !== pinnedBaseUrl)];
}

export interface VisionAttempt {
  baseUrl: string;
  /** `VisionErrorCode`, or `ok` / `unknown`. */
  code: string;
  message: string;
}

export interface VisionChainResult extends VisionAnswer {
  /** The gateway that actually answered. */
  config: VisionSettings;
  /** Every gateway tried, in order, with why it failed. Useful in the console. */
  attempts: VisionAttempt[];
}

export interface AskVisionChainOptions {
  configs: readonly VisionSettings[];
  prompt: string;
  images: VisionImageInput[];
  timeoutMs?: number;
  fetchImpl?: FetchLike;
  ports?: VisionPinPorts;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function summariseFailure(firstError: unknown, attempts: readonly VisionAttempt[]): VisionError {
  const code = firstError instanceof VisionError ? firstError.code : 'network';
  const status = firstError instanceof VisionError ? firstError.status : undefined;
  const head =
    firstError instanceof Error && firstError.message ? firstError.message : '视觉接口全部不可用';
  const others = attempts
    .filter((attempt) => attempt !== attempts[0])
    .map((attempt) => `${hostOf(attempt.baseUrl)}：${attempt.message}`);
  const message = others.length > 0 ? `${head}（另外 ${others.join('；')}）` : head;
  return new VisionError(code, message, status);
}

/**
 * Ask the gateways in order until one answers.
 *
 * Accepts already-resolved configs (see `resolveVisionConfigs`) so callers that
 * cache on the endpoint set keep control over the key.
 */
export async function askVisionWithFallback(
  options: AskVisionChainOptions,
): Promise<VisionChainResult> {
  const { configs, prompt, images, timeoutMs, fetchImpl } = options;
  if (configs.length === 0) {
    throw new VisionError('network', '没有配置视觉接口');
  }

  const ports = options.ports ?? {};
  const loadPin = ports.loadPin ?? loadPinnedBaseUrl;
  const savePin = ports.savePin ?? savePinnedBaseUrl;

  const pinned = await loadPin().catch(() => '');
  const ordered = orderByPin(configs, pinned);

  const attempts: VisionAttempt[] = [];
  let firstError: unknown = null;

  for (const config of ordered) {
    try {
      const answer = await askVisionJson({ config, prompt, images, timeoutMs, fetchImpl });
      attempts.push({ baseUrl: config.baseUrl, code: 'ok', message: '成功' });
      // Only a success moves the pin. Pinning on failure would let a flapping
      // gateway pull itself to the front over and over. A broken pin store must
      // not eat an answer we already have, hence the swallow.
      await savePin(config.baseUrl).catch(() => undefined);
      return { ...answer, config, attempts };
    } catch (error) {
      const code = error instanceof VisionError ? error.code : 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      attempts.push({ baseUrl: config.baseUrl, code, message });
      if (firstError === null) firstError = error;
    }
  }

  throw summariseFailure(firstError, attempts);
}
