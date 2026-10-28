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
import { askVisionWithFallback } from '../vision-endpoints';
import type { FetchLike } from '../vision-client';
import { PACKAGING_LABEL_PATTERN, type SupportSlotRequest } from './bind-materials';
import { FILL_MAX, FILL_MIN } from './solve-fill';

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
  /** Collage slots the model filled: `slotId -> materialId`. Empty for two-slot templates. */
  slotMaterialIds: Record<string, string>;
  /**
   * How much of the canvas each picture slot should cover: `slotId -> 0-1`.
   *
   * The model is the only party that sees all the photos side by side, so it is the
   * only one that can say "the action pose reads as the subject, the back view is
   * scenery". Geometry stays deterministic: this number goes to `solveSupportFill` /
   * the hero dominance band, never to a pixel coordinate.
   */
  fills: Record<string, number>;
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

export function buildBindingPrompt(
  candidates: ReadonlyArray<{ key: string; label: string }>,
  slots: readonly SupportSlotRequest[] = [],
  heroSlotId?: string,
): string {
  const listing = candidates.map((candidate) => `${candidate.key}（${candidate.label}）`).join('、');
  const lines = [
    '你是电商主图排版助手。下面几张图是同一件商品的素材（都已抠图去背景），编号为：' + listing + '。',
    '',
    '请判断：',
    '- 哪一张适合做"特写主体"（hero）：单件商品、有清晰立面、适合放大裁切；',
    '- 哪一张是"包装盒"（package）：外包装、盒体、可见盒面。',
  ];

  if (slots.length > 0) {
    lines.push(
      '',
      '另外还要为下面这些图位各挑一张**互不相同**的图（也不能和 hero 用同一张）：',
      ...slots.map((slot) => {
        const hints: string[] = [];
        if (slot.viewTypes?.length) hints.push(`优先选：${slot.viewTypes.join(' / ')}`);
        if (slot.framing?.length) hints.push(`取景：${slot.framing.join(' / ')}`);
        if (slot.expectedClass) hints.push(`应该是一张「${slot.expectedClass}」`);
        if (slot.prefer?.length) hints.push(`希望：${slot.prefer.join('、')}`);
        if (slot.exclude?.length) hints.push(`不要：${slot.exclude.join('、')}`);
        return `- 图位 ${slot.slotId}${hints.length > 0 ? `（${hints.join('；')}）` : ''}`;
      }),
      '挑不出来就留空（把该图位填 null），不要拿同一张图凑数。',
    );
  }

  /*
    Occupancy is the one composition decision the model is asked for. It is cheap —
    one extra object in the same answer, no second request — and it is the only way
    to break the "three figures all the same size" look that the fixed template
    zooms produce when the supplier's photos happen to be similar.

    Only asked for alongside a collage: a two-slot hero/package template keeps the
    prompt (and therefore the behaviour) it has always had.
  */
  const sized = slots.length > 0 ? [...slots.map((slot) => slot.slotId), ...(heroSlotId ? [heroSlotId] : [])] : [];
  if (sized.length > 0) {
    lines.push(
      '',
      '再给每张进画面的图一个 size（占画布面积的份额，0.05–0.85）：' + sized.join('、') + '。',
      '- 主角最大、后景最小，不要给两个一样大的数；',
      '- 这是"这图案应该占多大一块"，不是裁切范围，位置由模板决定。',
    );
  }

  lines.push(
    '',
    '只输出一个 JSON，不要解释，格式：',
    slots.length > 0
      ? heroSlotId
        ? '{"hero":"A","package":"B","hero_confidence":0.9,"package_found":true,"slots":{"图位名":"C"},"size":{"图位名":0.18},"reason":"一句话"}'
        : '{"hero":"A","package":"B","hero_confidence":0.9,"package_found":true,"slots":{"图位名":"C"},"reason":"一句话"}'
      : '{"hero":"A","package":"B","hero_confidence":0.9,"package_found":true,"reason":"一句话"}',
    '',
    '如果没有任何一张是包装盒，package 填 null、package_found 填 false。',
    '不要把同一张图同时当作 hero 和 package。',
  );
  return lines.join('\n');
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
  slots: readonly SupportSlotRequest[] = [],
  heroSlotId?: string,
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

  // Collage slots: only keys the template asked for, only letters that exist, no
  // repeats and never the hero — a duplicate would render as the same photo twice,
  // which is the one thing a collage must not do.
  const slotMaterialIds: Record<string, string> = {};
  const rawSlots = record.slots;
  if (slots.length > 0 && rawSlots && typeof rawSlots === 'object' && !Array.isArray(rawSlots)) {
    const taken = new Set<string>([heroId]);
    for (const slot of slots) {
      const key = asKey((rawSlots as Record<string, unknown>)[slot.slotId]);
      if (!key) continue;
      const materialId = byKey.get(key);
      if (!materialId || taken.has(materialId)) continue;
      taken.add(materialId);
      slotMaterialIds[slot.slotId] = materialId;
    }
  }

  const rawConfidence = typeof record.hero_confidence === 'number' ? record.hero_confidence : 0;
  const confidence = Number.isFinite(rawConfidence)
    ? Math.min(1, Math.max(0, rawConfidence))
    : 0;

  const reason = typeof record.reason === 'string' && record.reason.trim() ? record.reason.trim() : '模型未给出理由';
  return { heroId, boxId, slotMaterialIds, fills: parseFills(record.size, slots, heroSlotId), confidence, reason };
}

/**
 * Occupancy hints (`size` in the answer): only slots the template asked about, only
 * finite numbers, clamped to a range that can actually be drawn.
 *
 * Dropping unknown keys matters more than it looks: a model that invents a slot id
 * would otherwise be sizing nothing, and a `size` of 40 (it meant percent) would
 * otherwise ask for a 40× canvas.
 */
function parseFills(
  raw: unknown,
  slots: readonly SupportSlotRequest[],
  heroSlotId?: string,
): Record<string, number> {
  const fills: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fills;
  const allowed = new Set<string>([...slots.map((slot) => slot.slotId), ...(heroSlotId ? [heroSlotId] : [])]);
  for (const [slotId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.has(slotId)) continue;
    const number = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(number)) continue;
    fills[slotId] = Math.min(FILL_MAX, Math.max(FILL_MIN, number));
  }
  return fills;
}

export interface VisionBindRequest {
  /**
   * Resolved gateways in priority order — the whole vision chain, not one entry.
   * The binder hands it to `askVisionWithFallback`, so "gateway down" is handled
   * here rather than by every caller.
   */
  configs: readonly VisionSettings[];
  candidates: VisionCandidate[];
  /** Collage picture slots to fill in the same answer; empty for two-slot layouts. */
  slots?: readonly SupportSlotRequest[];
  /**
   * The hero slot's id, when the template wants a size hint for it too.
   *
   * Without it the model would be told to size "图位 X" for the collage slots and
   * nothing about the subject — and the subject is the figure whose size matters
   * most on a 主图.
   */
  heroSlotId?: string;
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

  const answer = await askVisionWithFallback({
    configs: request.configs,
    prompt: buildBindingPrompt(
      keyed.map(({ key, label }) => ({ key, label })),
      request.slots ?? [],
      request.heroSlotId,
    ),
    images: keyed.map(({ key, dataUrl }) => ({ label: `图 ${key}：`, dataUrl })),
    timeoutMs: request.timeoutMs,
    fetchImpl: request.fetchImpl,
  });

  return parseBindingAnswer(answer.json, keyed, request.slots ?? [], request.heroSlotId);
}
