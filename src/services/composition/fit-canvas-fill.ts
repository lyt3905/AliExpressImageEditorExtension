/**
 * 「这页用得太满 / 太空 / 三张一样大」——把整体观感收进一个可算的区间。
 *
 * 单个图位的 zoom 是各图位自己的事（viewport + size 意向）；但三张图各自"合格"
 * 拼起来仍可能铺满到画布边缘、或三张一样大读不出主次。这一层只管两件整体的
 * 事：
 *   1. 层级差：最大那张与最小那张的差距，低于模板要求就把最小的往小收
 *      （往大放不可行 —— 放大会把画面推向更挤，而"不够素材就不凑"是底线）。
 *   2. 整体占位：可见内容并集占画布的份额，落在 [min_union, max_union] 之外就
 *      对可缩放的那几张同时乘一个系数，**相对差异不变**。
 *
 * 为什么只缩放 support 位、不动 hero：hero 的缩放由 `hero_dominance` 与包装盒
 * 可读性一起决定，它一变，判定"谁是主体"的那套约束就跟着动。整体的拥挤感
 * 主要来自后景那几张，拿它们开刀副作用最小。
 */

import type { AlphaProfile } from './alpha';
import { canvasOccupancy, type CanvasSize, type ContentPlacement } from './coverage';
import { measureLayout, type LayoutMetrics } from './measure-layout';
import { heroPlacement } from './solve-hero';
import { FILL_MAX_ZOOM_FACTOR, FILL_MIN_ZOOM_FACTOR } from './solve-fill';
import { warning, type CompositionWarning } from './warnings';
import type { CloseupSpec, CanvasFillRule } from './types';

const STEPS = 6;
const TOLERANCE = 0.02;

export const DEFAULT_CANVAS_FILL: CanvasFillRule = { minUnion: 0.34, maxUnion: 0.66, minHierarchy: 1.35 };

export interface CanvasFillItem {
  slotId: string;
  profile: AlphaProfile;
  closeup: CloseupSpec;
  /** 进场时的 zoom（模板名义值 × size 意向求解后的结果）。 */
  zoom: number;
}

export interface CanvasFillOutcome {
  items: Array<{ slotId: string; zoom: number; placement: ContentPlacement; occupancy: number }>;
  metrics: LayoutMetrics;
  /** 最终乘到的系数；1 表示没动。显示用，也是缓存/诊断的记账。 */
  scaledBy: number;
  warnings: CompositionWarning[];
}

export function fitCanvasFill(input: {
  items: readonly CanvasFillItem[];
  /** 只参与测量、不可缩放的那几张（hero / 包装盒）。 */
  fixed: ReadonlyArray<{ slotId: string; profile: AlphaProfile; placement: ContentPlacement }>;
  canvas: CanvasSize;
  rule?: Partial<CanvasFillRule>;
}): CanvasFillOutcome {
  const rule: CanvasFillRule = { ...DEFAULT_CANVAS_FILL, ...input.rule };
  const { items, fixed, canvas } = input;
  const warnings: CompositionWarning[] = [];
  const bound = (item: CanvasFillItem, zoom: number): number =>
    Math.min(item.closeup.zoom * FILL_MAX_ZOOM_FACTOR, Math.max(item.closeup.zoom * FILL_MIN_ZOOM_FACTOR, zoom));

  const place = (item: CanvasFillItem, zoom: number) => {
    const bounded = bound(item, zoom);
    const placement = heroPlacement(item.profile, item.closeup, bounded);
    return {
      slotId: item.slotId,
      zoom: bounded,
      placement,
      occupancy: canvasOccupancy(item.profile, placement, canvas),
    };
  };

  const measure = (state: ReturnType<typeof place>[]): LayoutMetrics =>
    measureLayout({
      canvas,
      pictures: [
        ...fixed.map((entry) => ({ slotId: entry.slotId, profile: entry.profile, placement: entry.placement })),
        ...state.map((entry) => {
          const source = items.find((item) => item.slotId === entry.slotId);
          return {
            slotId: entry.slotId,
            profile: (source as CanvasFillItem).profile,
            placement: entry.placement,
          };
        }),
      ],
    });

  let state = items.map((item) => place(item, item.zoom));
  let metrics = measure(state);

  /*
    层级差：只收最小的那一张。收到地板还不够就放弃并把话说清楚 —— 硬撑只会把
    support 位缩成一条看不清的边。

    只有一张可缩放项时这一步必须跳过：层级是"两张之间"的事，一张图的 ratio 恒为 1，
    不跳过就会把自己的图一路缩到地板。
  */
  for (let step = 0; step < STEPS && state.length > 1 && metrics.hierarchy < rule.minHierarchy; step += 1) {
    let smallest = 0;
    for (let index = 1; index < state.length; index += 1) {
      if (state[index].occupancy < state[smallest].occupancy) smallest = index;
    }
    const target = state[smallest];
    const item = items[smallest];
    const next = bound(item, target.zoom * 0.92);
    if (Math.abs(next - target.zoom) < 1e-4) break;
    state = state.map((entry, index) => (index === smallest ? place(item, next) : entry));
    metrics = measure(state);
  }
  if (state.length > 1 && metrics.hierarchy < rule.minHierarchy - 0.02) {
    warnings.push(
      warning(
        'hierarchy_flat',
        `三张图一样大时读不出主次，但最小的那张已经缩到模板允许的下限（层级差 ${metrics.hierarchy.toFixed(2)}，要求 ${rule.minHierarchy}）`,
        { slots: state.map((entry) => entry.slotId) },
      ),
    );
  }

  /*
    整体占位：对全部可缩放项乘同一个系数，所以相对差异（刚调好的层级差）不变。
  */
  const unionTarget = metrics.union > rule.maxUnion ? rule.maxUnion : metrics.union < rule.minUnion ? rule.minUnion : null;
  let scaledBy = 1;
  if (unionTarget !== null) {
    for (let step = 0; step < STEPS; step += 1) {
      const union = measure(state).union;
      if (Math.abs(union - unionTarget) <= TOLERANCE) break;
      const factor = Math.min(1.35, Math.max(0.74, Math.sqrt(unionTarget / Math.max(0.01, union))));
      const nextState = state.map((entry, index) => place(items[index], entry.zoom * factor));
      const nextUnion = measure(nextState).union;
      // 系数被地板/天花板吃掉时（都到头了）就别再来回蹭。
      if (Math.abs(nextUnion - union) < 0.002) break;
      state = nextState;
      scaledBy *= factor;
    }
    metrics = measure(state);
    if (metrics.union > rule.maxUnion + 0.04) {
      warnings.push(
        warning(
          'canvas_fill_capped',
          `背景图太大，已经缩到模板下限，整页仍占 ${(metrics.union * 100).toFixed(0)}%（上限 ${(rule.maxUnion * 100).toFixed(0)}%）`,
          { slots: state.map((entry) => entry.slotId) },
        ),
      );
    } else if (metrics.union < rule.minUnion - 0.04) {
      warnings.push(
        warning(
          'canvas_fill_short',
          `背景图已经放到模板上限，整页只占 ${(metrics.union * 100).toFixed(0)}%（下限 ${(rule.minUnion * 100).toFixed(0)}%）——多半是素材本身太小或太少`,
          { slots: state.map((entry) => entry.slotId) },
        ),
      );
    }
  }

  return { items: state, metrics, scaledBy: Math.round(scaledBy * 1000) / 1000, warnings };
}
