/**
 * 叠图秩序：谁挡谁、最大的站哪、留白齐不齐。
 *
 * 这些测试钉住三件事：① 只平移，绝不改缩放 —— 大小是 `size` 与模板的事；② 脸优先于构图，
 * 但为了躲脸让开中心时要说出来；③ 挪不开的时候发警告，不许假装没挡。
 */

import { describe, expect, it } from 'vitest';
import COLLAGE_SOURCE from '../../src/services/composition/templates/three_pose_figure_collage_white.v1.0.json';
import { opaqueProfile } from '../../src/services/composition/alpha';
import { arrangeCascade, headBandOf, type CascadeItem } from '../../src/services/composition/arrange-cascade';
import { buildCompositionPlan, type PlannerMaterial, type PlacedImage } from '../../src/services/composition/planner';
import { parseLayoutTemplateOrThrow } from '../../src/services/composition/template-schema';
import type { CascadeRule } from '../../src/services/composition/types';

const CANVAS = { width: 800, height: 800 };

const OFF: CascadeRule = { protectHead: 0, centerLargest: false, balanceMargins: false, maxShift: 0 };
const HEADS: CascadeRule = { protectHead: 0.24, centerLargest: false, balanceMargins: false, maxShift: 0.16 };

function item(
  slotId: string,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  rank: number,
): CascadeItem {
  return { slotId, profile: opaqueProfile(width, height), placement: { centerX, centerY, scale: 1 }, rank };
}

/** 内容盒（`opaqueProfile` 下 trim == 全图，所以盒 = 中心 ± 半宽高）。 */
function boxOf(content: CascadeItem, centerX: number, centerY: number): [number, number, number, number] {
  const { width, height } = content.profile.trim;
  return [centerX - width / 2, centerY - height / 2, centerX + width / 2, centerY + height / 2];
}

function overlap(a: readonly number[], b: readonly number[]): number {
  const width = Math.min(a[2]!, b[2]!) - Math.max(a[0]!, b[0]!);
  const height = Math.min(a[3]!, b[3]!) - Math.max(a[1]!, b[1]!);
  return width > 0 && height > 0 ? width * height : 0;
}

describe('arrangeCascade', () => {
  it('changes nothing when the template switches every rule off', () => {
    const back = item('back', 200, 400, 200, 200, 0);
    const front = item('front', 300, 500, 200, 250, 1);
    const outcome = arrangeCascade({ items: [back, front], canvas: CANVAS, rule: OFF });
    expect(outcome.placements.get('back')).toEqual(back.placement);
    expect(outcome.placements.get('front')).toEqual(front.placement);
    expect(outcome.warnings).toEqual([]);
  });

  it('puts the largest picture on the horizontal centre line', () => {
    const small = item('small', 120, 300, 120, 200, 0);
    const large = item('large', 300, 600, 200, 300, 1);
    const outcome = arrangeCascade({
      items: [small, large],
      canvas: CANVAS,
      rule: { protectHead: 0, centerLargest: true, balanceMargins: false, maxShift: 0.16 },
    });
    expect(outcome.placements.get('large')!.centerX).toBeCloseTo(400, 6);
    // The other one keeps its own x: centring is not a re-layout.
    expect(outcome.placements.get('small')!.centerX).toBeCloseTo(120, 6);
  });

  it('moves the covered picture out of the way instead of moving the hero', () => {
    // Front (rank 1) sits right on top of Back's head band; Back has room on the left.
    const back = item('back', 100, 300, 250, 150, 0);
    const front = item('front', 300, 500, 300, 250, 1);
    const outcome = arrangeCascade({
      items: [back, front],
      canvas: CANVAS,
      rule: { protectHead: 0.24, centerLargest: false, balanceMargins: false, maxShift: 0.3 },
    });
    const movedBack = outcome.placements.get('back')!;
    const keptFront = outcome.placements.get('front')!;
    expect(movedBack.centerX).not.toBeCloseTo(250, 6);
    expect(keptFront.centerX).toBeCloseTo(300, 6);
    const headBand = [boxOf(back, movedBack.centerX, movedBack.centerY)[0], boxOf(back, movedBack.centerX, movedBack.centerY)[1]] as const;
    const band: readonly number[] = [
      headBand[0],
      headBand[1],
      boxOf(back, movedBack.centerX, movedBack.centerY)[2],
      headBand[1] + back.profile.trim.height * 0.24,
    ];
    expect(overlap(boxOf(front, keptFront.centerX, keptFront.centerY), band)).toBe(0);
    expect(outcome.warnings.some((entry) => entry.code === 'head_occluded')).toBe(false);
  });

  it('lets the front picture give ground when the covered one cannot move', () => {
    /*
      Back is a wide picture hanging off the left edge: every shift that would clear
      the head leaves too little of it inside the canvas, so `staysInside` rejects all
      of them. Front only has to hop 30 px to the right — it goes, and the warning says
      the centring lost that round.
    */
    const back = item('back', 1000, 300, 50, 150, 0);
    const front = item('front', 100, 500, 560, 250, 1);
    const outcome = arrangeCascade({
      items: [back, front],
      canvas: CANVAS,
      rule: { protectHead: 0.24, centerLargest: false, balanceMargins: false, maxShift: 0.05 },
    });
    expect(outcome.placements.get('back')!.centerX).toBeCloseTo(50, 6);
    expect(outcome.placements.get('front')!.centerX).toBeGreaterThan(560);
    expect(outcome.warnings.map((entry) => entry.code)).toContain('cascade_center_tradeoff');
  });

  it('warns when nothing can be moved far enough', () => {
    // Both are wider than the shift budget allows and the band is dead centre.
    const back = item('back', 400, 300, 400, 150, 0);
    const front = item('front', 700, 600, 400, 300, 1);
    const outcome = arrangeCascade({ items: [back, front], canvas: CANVAS, rule: HEADS });
    expect(outcome.warnings.map((entry) => entry.code)).toContain('head_occluded');
  });

  it('aligns the outer margins by sliding the whole group', () => {
    const left = item('left', 300, 400, 250, 250, 0);
    const right = item('right', 200, 400, 500, 250, 1);
    const outcome = arrangeCascade({
      items: [left, right],
      canvas: CANVAS,
      rule: { protectHead: 0, centerLargest: false, balanceMargins: true, maxShift: 0 },
    });
    const shiftedLeft = outcome.placements.get('left')!;
    const shiftedRight = outcome.placements.get('right')!;
    const dx = shiftedLeft.centerX - 250;
    expect(shiftedRight.centerX - 500).toBeCloseTo(dx, 6);
    // union was 100..600 → equal gaps need +50 on both.
    expect(dx).toBeCloseTo(50, 6);
    expect(outcome.warnings).toEqual([]);
  });

  it('admits it when the content already runs off the canvas', () => {
    // 900 px of content on an 800 px canvas: no single shift can equalise the gaps.
    const wide = item('wide', 900, 400, 400, 200, 0);
    const outcome = arrangeCascade({
      items: [wide],
      canvas: CANVAS,
      rule: { protectHead: 0, centerLargest: false, balanceMargins: true, maxShift: 0 },
    });
    expect(outcome.warnings.map((entry) => entry.code)).toContain('margins_uneven');
  });
});

describe('the collage template uses cascade rules', () => {
  const TEMPLATE = parseLayoutTemplateOrThrow(COLLAGE_SOURCE);

  function material(id: string, width: number, height: number): PlannerMaterial {
    return {
      materialId: `material-${id}`,
      blobId: `blob-${id}`,
      kind: 'cutout',
      profile: opaqueProfile(width, height),
      label: id,
    };
  }

  function plan() {
    /*
      A realistic answer from the model: the action pose is the hero, the front view
      reads second, the back view is the backdrop. Sizes matter here — three figures at
      the template's nominal zoom are all close to full height and no amount of shifting
      keeps three heads apart, which is exactly why `size` and `cascade` arrived together.
    */
    return buildCompositionPlan({
      template: TEMPLATE,
      hero: material('hero', 900, 1800),
      supports: [
        { slotId: 'rear_view_background', material: material('rear', 700, 1400) },
        { slotId: 'front_view_right', material: material('front', 800, 1600) },
      ],
      fills: { action_pose_left_hero: 0.34, rear_view_background: 0.08, front_view_right: 0.2 },
    });
  }

  /** Layer-space box (opaque profiles → content == source). */
  function boxOfImage(image: PlacedImage): [number, number, number, number] {
    const width = image.sourceWidth * image.scale;
    const height = image.sourceHeight * image.scale;
    return [image.x - width / 2, image.y - height / 2, image.x + width / 2, image.y + height / 2];
  }

  it('keeps every head clear of the layers painted after it', () => {
    const built = plan();
    expect(built.warnings.some((entry) => entry.code === 'head_occluded')).toBe(false);
    const ordered = [...built.images].sort((a, b) => a.zIndex - b.zIndex);
    ordered.forEach((back, index) => {
      // 用代码里的同一个定义算"脸在哪"，测试和实现不许各有一套。
      const band = headBandOf(
        opaqueProfile(back.sourceWidth, back.sourceHeight),
        { centerX: back.x, centerY: back.y, scale: back.scale },
        0.24,
        CANVAS,
      );
      if (!band) return;
      const bandArea = Math.max(0, band[2] - band[0]) * Math.max(0, band[3] - band[1]);
      for (const front of ordered.slice(index + 1)) {
        /*
          头部允许被"擦到" 6 %（发型、天线本来就互相穿插），这条线是 `HEAD_TOLERANCE`：
          断言的是"脸能认出来"，不是"像素级零重叠"。
        */
        expect(overlap(boxOfImage(front), band) / bandArea).toBeLessThanOrEqual(0.06);
      }
    });
  });

  it('leaves equal white space on the left and right', () => {
    const built = plan();
    expect(built.warnings.some((entry) => entry.code === 'margins_uneven')).toBe(false);
    const boxes = built.images.map(boxOfImage);
    const left = Math.min(...boxes.map((box) => box[0]));
    const right = Math.max(...boxes.map((box) => box[2]));
    expect(left).toBeCloseTo(800 - right, 0);
  });
});
