/**
 * Decide which material plays which role.
 *
 * Today this is label-based heuristics; the plan is for a vision model to make
 * the call (see the compose panel), with this as the fallback when it is
 * unavailable. Keeping it a pure function means the fallback is testable and the
 * UI can show WHY a material was chosen.
 *
 * The one rule worth stating: a single material is always the hero. A product with
 * one photo should still be composable — refusing because "no package found" would
 * make the feature useless for half the catalogue.
 */

export interface BindCandidate {
  materialId: string;
  label?: string;
  width: number;
  height: number;
}

export interface BindResult {
  heroId: string | null;
  boxId: string | null;
  /** Short Chinese explanation, shown in the panel. */
  reason: string;
}

/** Labels that mean "this is packaging, not the product". */
const BOX_LABEL_PATTERN = /包装|彩盒|礼盒|盒子|外箱|箱|packag|package|box|carton/i;

export function bindMaterialRoles(candidates: readonly BindCandidate[]): BindResult {
  if (candidates.length === 0) {
    return { heroId: null, boxId: null, reason: '没有可用素材' };
  }
  if (candidates.length === 1) {
    return {
      heroId: candidates[0].materialId,
      boxId: null,
      reason: '只有一张素材，作为主体使用',
    };
  }

  const box = candidates.find((candidate) => BOX_LABEL_PATTERN.test(candidate.label ?? ''));
  const heroPool = box ? candidates.filter((candidate) => candidate !== box) : candidates;
  // Largest area wins: on a product page the 正面图 is usually the biggest crop.
  const hero = heroPool.reduce((best, candidate) =>
    candidate.width * candidate.height > best.width * best.height ? candidate : best,
  );

  if (box) {
    return {
      heroId: hero.materialId,
      boxId: box.materialId,
      reason: `按素材标签识别到包装盒「${box.label ?? box.materialId}」，其余取面积最大者作主体`,
    };
  }
  return {
    heroId: hero.materialId,
    boxId: null,
    reason: '素材标签里没有包装盒，取面积最大的一张作主体',
  };
}

/**
 * Next-best material for the `secondary_view` fallback rung.
 *
 * Deliberately ignores the box-label heuristic: when there is no package photo at
 * all, any remaining photo of the same product is a better filler than an empty
 * slot.
 */
export function pickSecondary(
  candidates: readonly BindCandidate[],
  usedIds: readonly (string | null | undefined)[],
): BindCandidate | null {
  const used = new Set(usedIds.filter((id): id is string => Boolean(id)));
  const remaining = candidates.filter((candidate) => !used.has(candidate.materialId));
  if (remaining.length === 0) return null;
  return remaining.reduce((best, candidate) =>
    candidate.width * candidate.height > best.width * best.height ? candidate : best,
  );
}
