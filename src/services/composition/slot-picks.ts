/**
 * 手工指定「哪个图位放哪张素材」（M3）。
 *
 * M2 之前，图位与素材的对应关系完全由 AI 决定（`vision-binder` +
 * `selectSupportMaterials`）。这对"模型认得出来"的素材是对的，但模型会犯错，而卖家
 * 手上有眼睛：背景挑错了、细节图该用俯拍那张、主体被认成了配件 —— 这些都不需要
 * 重新问一次 AI，只需要"这一个图位换成那张图"。
 *
 * 所以这里是**覆盖层**而不是第二套分配逻辑：自动结果先跑出来，再由用户点名的那几个
 * 槽位被替换；没点名的槽位一个字都不变。这样"手工改一张"不会连带重排其它图位，
 * 也不会把 AI 的结论整份丢掉。
 *
 * 三条刻意的规则：
 *
 * 1. 点名的槽位不存在、或不是图片槽位（文字区 / 衬板）→ 忽略并回报，不猜、不报错。
 *    宁可少换一张，也不要因为一个过期的 id 让整次排版失败。
 * 2. 同一张素材可以被点名两次。去重是自动路径的规则（`allow_source_reuse` 之外
 *    不许复用以防"拼贴里同一张图出现两次像 bug"），但手工点名是明确意图 ——
 *    用户说"这两格都用这张"，就照办。
 * 3. 主体与包装盒槽位也走同一张表，因为它们同样是"哪个图位放哪张素材"。
 */

import type { LayoutTemplate, SlotRole } from './types';

/** 一个可以手工指定素材的图位，顺序即绘制顺序（先画的下面的）。 */
export interface SlotPickOption {
  slotId: string;
  role: SlotRole;
  required: boolean;
  zIndex: number;
  /** 该槽位是否允许复用同一张素材（装饰背景才该开）。 */
  allowSourceReuse: boolean;
}

export interface SlotPickPlan {
  /** 点名的主体素材；null = 沿用自动结论。 */
  heroMaterialId: string | null;
  /** 点名的包装盒素材；null = 沿用自动结论。 */
  boxMaterialId: string | null;
  /** 点名的其余图位，按绘制顺序。 */
  supports: Array<{ slotId: string; materialId: string }>;
  /** 点了名但用不上的槽位 id（不存在 / 不是图片槽位 / 素材 id 是空串）。 */
  ignored: string[];
}

/**
 * 模板里所有能放图的槽位：`hero`、`box`，以及声明了 `closeup` 的其余角色。
 *
 * 文字区与衬板不在其中 —— 它们放不下一张照片，给它们一个"素材"下拉框只会让用户
 * 以为那是能换的。
 */
export function pickableSlots(template: LayoutTemplate): SlotPickOption[] {
  const renderOrder = template.rules.renderOrder;
  const rank = (slotId: string, zIndex: number): number => {
    const index = renderOrder?.indexOf(slotId) ?? -1;
    return index === -1 ? zIndex : index;
  };
  return template.slots
    .filter((slot) => slot.role === 'hero' || slot.role === 'box' || slot.closeup !== undefined)
    .sort((left, right) => rank(left.id, left.zIndex) - rank(right.id, right.zIndex))
    .map((slot) => ({
      slotId: slot.id,
      role: slot.role,
      required: slot.required,
      zIndex: slot.zIndex,
      allowSourceReuse: slot.allowSourceReuse === true,
    }));
}

export interface SlotPickRequest {
  template: LayoutTemplate;
  /** slotId -> materialId；`null` / `undefined` / 空串都表示"自动"。 */
  picks: Readonly<Record<string, string | null | undefined>>;
}

export function resolveSlotPicks({ template, picks }: SlotPickRequest): SlotPickPlan {
  const options = new Map(pickableSlots(template).map((option) => [option.slotId, option]));
  const plan: SlotPickPlan = { heroMaterialId: null, boxMaterialId: null, supports: [], ignored: [] };

  for (const [slotId, rawMaterialId] of Object.entries(picks)) {
    const materialId = typeof rawMaterialId === 'string' ? rawMaterialId.trim() : '';
    if (materialId === '') continue;
    const option = options.get(slotId);
    if (!option) {
      plan.ignored.push(slotId);
      continue;
    }
    if (option.role === 'hero') {
      plan.heroMaterialId = materialId;
      continue;
    }
    if (option.role === 'box') {
      plan.boxMaterialId = materialId;
      continue;
    }
    plan.supports.push({ slotId, materialId });
  }

  // 按绘制顺序排队：先画的（z 小的）在下，和 planner 的 `supports` 语义对齐。
  const order = new Map(pickableSlots(template).map((option, index) => [option.slotId, index]));
  plan.supports.sort((left, right) => (order.get(left.slotId) ?? 0) - (order.get(right.slotId) ?? 0));
  return plan;
}

/** 这个槽位是不是被用户点过名（面板上用来把下拉框标成"手工"）。 */
export function isPicked(picks: Readonly<Record<string, string | null | undefined>>, slotId: string): boolean {
  const value = picks[slotId];
  return typeof value === 'string' && value.trim() !== '';
}

/** 换模板后清空：槽位 id 是模板的一部分，跨模板留下只会变成"过期 id"。 */
export function prunePicks(
  picks: Readonly<Record<string, string | null | undefined>>,
  template: LayoutTemplate,
): Record<string, string> {
  const options = new Set(pickableSlots(template).map((option) => option.slotId));
  const next: Record<string, string> = {};
  for (const [slotId, materialId] of Object.entries(picks)) {
    if (!options.has(slotId)) continue;
    const trimmed = typeof materialId === 'string' ? materialId.trim() : '';
    if (trimmed !== '') next[slotId] = trimmed;
  }
  return next;
}
