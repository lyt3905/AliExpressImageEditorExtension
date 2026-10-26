/**
 * Ask the vision model which material is the hero and which is the packaging.
 *
 * The geometry layer does not care where a binding came from; this module only has
 * to turn a model answer into `{heroId, boxId}` and refuse to guess when the answer
 * is unusable. `bind-materials.ts` stays as the fallback, so a gateway that is down
 * degrades to label heuristics instead of breaking the feature.
 *
 * The prompt and the answer shape were verified against the live gateway with two
 * synthetic images (product + box): correct roles, confidence 0.9, clean JSON in
 * ~4.5 s. The `key` letters (A/B/C) are what the model answers with, then mapped
 * back to material ids here — asking the model to echo opaque ids invites typos.
 */

import { VISION_MAX_CANDIDATES } from '../../shared/constants';
import type { VisionSettings } from '../settings';
import { askVisionJson, type FetchLike } from '../vision-client';
import { PACKAGING_LABEL_PATTERN } from './bind-materials';

export interface VisionCandidate {
  materialId: string;
  /** Human label from the product page, shown to the model as context. */
  label: string;
  /** `data:image/...;base64,...` thumbnail. */
  dataUrl: string;
}

export interface VisionBinding {
  heroId: string | null;
  boxId: string | null;
  confidence: number;
  reason: string;
}

const KEYS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

/**
 * Decide which candidates are worth spending a slot on.
 *
 * Taking "the first N" is the wrong rule: a product page can carry more cut-outs
 * than the six slots (extra uploads / pastes), and the packaging photo is exactly
 * the one most likely to fall off the end — which is the one role the model exists
 * to find. So when the list is too long, anything whose label looks like packaging
 * is kept first, and the rest follow in page order.
 *
 * The chosen candidates keep their ORIGINAL relative order, so the letters A/B/C
 * still read left-to-right like the page and a human comparing the answer to the
 * panel sees the same sequence.
 */
export function selectVisionCandidates<T extends { label: string }>(
  candidates: readonly T[],
  limit: number = VISION_MAX_CANDIDATES,
): T[] {
  if (candidates.length <= limit) return [...candidates];

  const scored = candidates.map((candidate, index) => ({
    candidate,
    index,
    packaging: PACKAGING_LABEL_PATTERN.test(candidate.label) ? 1 : 0,
  }));
  scored.sort((left, right) => right.packaging - left.packaging || left.index - right.index);

  return scored
    .slice(0, limit)
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.candidate);
}

export function buildBindingPrompt(candidates: ReadonlyArray<{ key: string; label: string }>): string {
  const listing = candidates.map((candidate) => `${candidate.key}（${candidate.label}）`).join('、');
  return [
    '你是电商主图排版助手。下面几张图是同一件商品的素材（都已抠图去背景），编号为：' + listing + '。',
    '',
    '请判断：',
    '- 哪一张适合做"特写主体"（hero）：单件商品、有清晰立面、适合放大裁切；',
    '- 哪一张是"包装盒"（package）：外包装、盒体、可见盒面。',
    '',
    '只输出一个 JSON，不要解释，格式：',
    '{"hero":"A","package":"B","hero_confidence":0.9,"package_found":true,"reason":"一句话"}',
    '',
    '如果没有任何一张是包装盒，package 填 null、package_found 填 false。',
    '不要把同一张图同时当作 hero 和 package。',
  ].join('\n');
}

function asKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase().replace(/^图\s*/, '');
  return /^[A-F]$/.test(trimmed) ? trimmed : null;
}

/**
 * Map the model's answer onto material ids.
 *
 * Returns null when the hero cannot be resolved — an unusable answer must reach the
 * caller as "no answer", never as a silent default, because a wrong hero produces a
 * plausible-looking layout nobody notices is wrong.
 */
export function parseBindingAnswer(
  json: unknown,
  candidates: ReadonlyArray<{ key: string; materialId: string }>,
): VisionBinding | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const record = json as Record<string, unknown>;

  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate.materialId]));
  const heroKey = asKey(record.hero);
  const heroId = heroKey ? byKey.get(heroKey) ?? null : null;
  if (!heroId) return null;

  const packageFound = record.package_found === true;
  const packageKey = asKey(record.package);
  const boxId =
    packageFound && packageKey && packageKey !== heroKey ? byKey.get(packageKey) ?? null : null;

  const rawConfidence = typeof record.hero_confidence === 'number' ? record.hero_confidence : 0;
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0;

  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : '模型未给出理由';
  return { heroId, boxId, confidence, reason };
}

export interface VisionBindRequest {
  config: VisionSettings;
  candidates: VisionCandidate[];
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

/**
 * Bind roles via the vision model.
 *
 * Throws `VisionError` on any transport/parse problem and returns null when the
 * answer is usable but names no valid hero — the two are different to the UI: one
 * says "gateway unreachable", the other says "the model could not decide".
 */
export async function bindMaterialsWithVision(request: VisionBindRequest): Promise<VisionBinding | null> {
  const candidates = selectVisionCandidates(request.candidates);
  if (candidates.length === 0) return null;

  const keyed = candidates.map((candidate, index) => ({
    key: KEYS[index] ?? `X${index}`,
    materialId: candidate.materialId,
    label: candidate.label,
    dataUrl: candidate.dataUrl,
  }));

  const answer = await askVisionJson({
    config: request.config,
    prompt: buildBindingPrompt(keyed.map(({ key, label }) => ({ key, label }))),
    images: keyed.map(({ key, dataUrl }) => ({ label: `图 ${key}：`, dataUrl })),
    timeoutMs: request.timeoutMs,
    fetchImpl: request.fetchImpl,
  });

  return parseBindingAnswer(answer.json, keyed);
}
