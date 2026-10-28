/**
 * 设置页里几个纯函数：视觉接口行的存取形态、时间/镜像的显示文案。
 *
 * 从 `App.tsx` 里搬出来的：分区组件也要用 `endpointLabel()` 画摘要，而
 * `App.tsx` 已经会 import 分区组件——放在这里两边都能拿，不会绕成循环依赖。
 */

import { DEFAULT_VISION_BASE_URL, DEFAULT_VISION_MODEL } from '../shared/constants';
import type { VisionEndpoint } from '../services/settings';

export function formatTimestamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function catalogMirrorLabel(baseUrl: string | null): string {
  if (!baseUrl) return '';
  if (baseUrl.includes('jsdelivr')) return 'jsDelivr 镜像';
  if (baseUrl.includes('raw.githubusercontent.com')) return 'raw.githubusercontent.com';
  // A URL the seller typed in themselves — show its host, not "raw.github…".
  try {
    return `${new URL(baseUrl).host}（自填）`;
  } catch {
    return baseUrl;
  }
}

/**
 * The rows an empty chain falls back to: the built-in local gateway, with the
 * model pre-filled and the key left blank so it inherits the build-time default.
 */
export function defaultEndpointRows(): VisionEndpoint[] {
  return [{ baseUrl: DEFAULT_VISION_BASE_URL, model: DEFAULT_VISION_MODEL, apiKey: '' }];
}

/**
 * Rows as they go into storage.
 *
 * Blank addresses are dropped (a row with no address can never be tried, and
 * keeping it would make the list claim a gateway that never fires). A blank
 * `model` / `apiKey` is kept blank on purpose: blank means "inherit from the first
 * row", and that resolution happens at call time, not here.
 */
export function rowsForSave(rows: readonly VisionEndpoint[]): VisionEndpoint[] {
  return rows
    .map((row) => ({
      baseUrl: row.baseUrl.trim(),
      model: row.model.trim(),
      apiKey: row.apiKey.trim(),
    }))
    .filter((row) => row.baseUrl.length > 0);
}

/**
 * What the row shows for one gateway: its place in the chain plus its host.
 *
 * The host is what actually tells two rows apart — three rows all reading
 * 「备用接口」are indistinguishable until you open each one. Empty rows say so
 * instead of showing nothing.
 */
export function endpointLabel(endpoint: VisionEndpoint, index: number): string {
  const name = index === 0 ? '主接口' : `备用接口 ${index + 1}`;
  const raw = endpoint.baseUrl.trim();
  if (raw.length === 0) return `${name} — 未填地址`;
  try {
    return `${name} — ${new URL(raw).host}`;
  } catch {
    return `${name} — ${raw}`;
  }
}

/** 只要主机名，行里单独一列用。 */
export function endpointHost(endpoint: VisionEndpoint): string {
  const raw = endpoint.baseUrl.trim();
  if (raw.length === 0) return '未填地址';
  try {
    return new URL(raw).host;
  } catch {
    return raw;
  }
}

/**
 * A brand-new row: address blank, model/key blank so they inherit the main row.
 */
export function blankEndpoint(): VisionEndpoint {
  return { baseUrl: '', model: '', apiKey: '' };
}
