import type { AlphaProfile } from './alpha';
import { canvasOccupancy, contentRect, type CanvasSize, type ContentPlacement } from './coverage';
import type { CascadeRule } from './types';
import { warning, type CompositionWarning } from './warnings';

/**
 * 叠图秩序：把"谁挡谁"从偶然变成规则。
 *
 * 拼贴的位置是设计师画的结论，所以这里**只做平移**，不缩放、不改叠放顺序、不新增图层。
 * 三件事按顺序做，每一步都能解释：
 *
 * 1. `centerLargest` —— 面积最大的那张挪到画布水平中心。"视觉中心"就是那个占了大半张图
 *    的东西站中间，其余围着它。纵向不动：三个姿态共享一条基线，往中间挪只会把脚抬起来。
 * 2. `protectHead` —— 后画的图不许压住先画的图的头。先挪被挡的那张（它通常更小、更靠边，
 *    动它代价小），挪不开再挪挡人的那张；都不行就发警告，而不是假装没挡。
 * 3. `balanceMargins` —— 所有画面图层整体平移，让左右、上下留白相等。整体动不改变相对位置，
 *    所以不会把第 2 步刚躲开的脸又挡回去。
 *
 * 所有平移都受 `maxShift` 约束：为了躲一张脸把人物推出画布，是拿构图换构图。
 */

/** 头带里还能容忍被压住的比例。手办的发型/天线本就容易互相擦到，零容忍会让拼贴摆不开。 */
const HEAD_TOLERANCE = 0.06;

/** 留白差多少才算"不齐"（占画布宽/高的比例）。低于这个数肉眼看不出，不值得再挪。 */
const MARGIN_TOLERANCE = 0.02;

/** 平移阶梯的格数：16 格已经细到 1% 以内，再细只是多算几轮。 */
const SHIFT_STEPS = 16;

/** 一张图至少要有这么多横向内容留在画布里，否则挪得再对也不算候选。 */
const MIN_STAY_INSIDE = 0.6;

export interface CascadeItem {
  slotId: string;
  profile: AlphaProfile;
  placement: ContentPlacement;
  /** 绘制顺序，升序（先画的在后，后画的在前）。 */
  rank: number;
}

export interface CascadeOutcome {
  placements: Map<string, ContentPlacement>;
  warnings: CompositionWarning[];
}

export type Rect = readonly [number, number, number, number];

function intersect(a: Rect, b: Rect): Rect | null {
  const left = Math.max(a[0], b[0]);
  const top = Math.max(a[1], b[1]);
  const right = Math.min(a[2], b[2]);
  const bottom = Math.min(a[3], b[3]);
  if (right <= left || bottom <= top) return null;
  return [left, top, right, bottom];
}

function area(rect: Rect | null): number {
  return rect ? Math.max(0, rect[2] - rect[0]) * Math.max(0, rect[3] - rect[1]) : 0;
}

function clipToCanvas(rect: Rect, canvas: CanvasSize): Rect | null {
  return intersect(rect, [0, 0, canvas.width, canvas.height]);
}

/** 内容盒的上 `protectHead` 高度那一截 —— 这张图的"脸"，已经裁到画布里。 */
export function headBandOf(
  profile: AlphaProfile,
  placement: ContentPlacement,
  protectHead: number,
  canvas: CanvasSize,
): Rect | null {
  const box = contentRect(profile, placement);
  const height = box[3] - box[1];
  return clipToCanvas([box[0], box[1], box[2], box[1] + height * protectHead], canvas);
}

function withShift(placement: ContentPlacement, dx: number, dy = 0): ContentPlacement {
  return { centerX: placement.centerX + dx, centerY: placement.centerY + dy, scale: placement.scale };
}

function staysInside(profile: AlphaProfile, placement: ContentPlacement, canvas: CanvasSize): boolean {
  const box = contentRect(profile, placement);
  const inside = area(clipToCanvas(box, canvas));
  return inside >= area(box) * MIN_STAY_INSIDE;
}

/** 候选平移量：先小后大，正负交替，方便取"最小代价"的解。 */
function shiftLadder(maxPx: number): number[] {
  const step = maxPx / SHIFT_STEPS;
  const out: number[] = [];
  for (let k = 1; k <= SHIFT_STEPS; k += 1) {
    out.push(k * step, -k * step);
  }
  return out;
}

export function arrangeCascade(input: {
  items: readonly CascadeItem[];
  canvas: CanvasSize;
  rule: CascadeRule;
}): CascadeOutcome {
  const placements = new Map<string, ContentPlacement>();
  for (const item of input.items) placements.set(item.slotId, item.placement);

  const warnings: CompositionWarning[] = [];
  const order = [...input.items].sort((a, b) => a.rank - b.rank);
  if (order.length === 0) return { placements, warnings };

  const canvas = input.canvas;
  const maxShiftX = Math.max(0, input.rule.maxShift) * canvas.width;
  const ladder = shiftLadder(maxShiftX);

  // ---- 1. 最大的那张站到水平中心 -----------------------------------------
  if (input.rule.centerLargest) {
    const largest = order.reduce((best, item) =>
      canvasOccupancy(item.profile, placements.get(item.slotId)!, canvas) >
      canvasOccupancy(best.profile, placements.get(best.slotId)!, canvas)
        ? item
        : best,
    );
    const placement = placements.get(largest.slotId)!;
    const box = contentRect(largest.profile, placement);
    const dx = canvas.width / 2 - (box[0] + box[2]) / 2;
    const moved = withShift(placement, dx);
    if (staysInside(largest.profile, moved, canvas)) placements.set(largest.slotId, moved);
  }

  // ---- 2. 后画的不许压住先画的头 ----------------------------------------
  const clearing = (back: CascadeItem, front: CascadeItem): number => {
    const head = headBandOf(back.profile, placements.get(back.slotId)!, input.rule.protectHead, canvas);
    if (!head) return 0;
    const covered = area(intersect(contentRect(front.profile, placements.get(front.slotId)!), head)) / area(head);
    return covered <= HEAD_TOLERANCE ? 0 : covered;
  };

  const tryShift = (mover: CascadeItem, back: CascadeItem, front: CascadeItem): boolean => {
    const before = placements.get(mover.slotId)!;
    for (const dx of ladder) {
      const candidate = withShift(before, dx);
      if (!staysInside(mover.profile, candidate, canvas)) continue;
      placements.set(mover.slotId, candidate);
      if (clearing(back, front) === 0) return true;
      placements.set(mover.slotId, before);
    }
    return false;
  };

  for (let i = 0; i < order.length; i += 1) {
    for (let j = i + 1; j < order.length; j += 1) {
      const back = order[i]!;
      const front = order[j]!;
      const covered = clearing(back, front);
      if (covered === 0) continue;
      // 先动被挡的那张：它通常更小、更靠边，动它比动主角更不伤构图。
      if (tryShift(back, back, front)) continue;
      if (tryShift(front, back, front)) {
        const wasCentered = input.rule.centerLargest;
        warnings.push(
          warning(
            'cascade_center_tradeoff',
            `为了不挡住 ${back.slotId} 的头部，${front.slotId} 从中心让开了${wasCentered ? '（它原本是画面最大的那张）' : ''}`,
            { back: back.slotId, front: front.slotId },
          ),
        );
        continue;
      }
      warnings.push(
        warning('head_occluded', `${front.slotId} 压住了 ${back.slotId} 的头部（可挪范围 ${Math.round(input.rule.maxShift * 100)}% 内没有解）`, {
          back: back.slotId,
          front: front.slotId,
          covered: Math.round(covered * 1000) / 1000,
        }),
      );
    }
  }

  // ---- 3. 四边留白对齐 ---------------------------------------------------
  if (input.rule.balanceMargins) {
    /*
      用**未裁切**的内容盒算留白。裁切过的盒子会把"已经超出画布"的那部分抹平，
      于是 `left + right === canvas.width` 恒成立，`margins_uneven` 永远不会发 ——
      而那种情况恰恰是最该说的：内容已经顶出画布，四边不可能一样宽。
    */
    const boxes = order.map((item) => contentRect(item.profile, placements.get(item.slotId)!));
    if (boxes.length > 0) {
      const left = Math.min(...boxes.map((box) => box[0]));
      const right = Math.max(...boxes.map((box) => box[2]));
      const top = Math.min(...boxes.map((box) => box[1]));
      const bottom = Math.max(...boxes.map((box) => box[3]));
      let dx = (canvas.width - right - left) / 2;
      let dy = (canvas.height - bottom - top) / 2;
      // 整体平移：内容已经顶到边上时，只允许往空的那侧挪，不许把内容推出画布。
      dx = Math.max(-left, Math.min(canvas.width - right, dx));
      dy = Math.max(-top, Math.min(canvas.height - bottom, dy));
      if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) {
        for (const item of order) {
          const placement = placements.get(item.slotId)!;
          placements.set(item.slotId, withShift(placement, dx, dy));
        }
      }
      const residualX = Math.abs(canvas.width - right - left - 2 * dx) / canvas.width;
      const residualY = Math.abs(canvas.height - bottom - top - 2 * dy) / canvas.height;
      if (Math.max(residualX, residualY) > MARGIN_TOLERANCE) {
        warnings.push(
          warning('margins_uneven', '四边留白没能对齐：内容已经贴到画布边界，再挪就要裁掉人物', {
            left: Math.round(left),
            right: Math.round(canvas.width - right),
            top: Math.round(top),
            bottom: Math.round(canvas.height - bottom),
          }),
        );
      }
    }
  }

  return { placements, warnings };
}
