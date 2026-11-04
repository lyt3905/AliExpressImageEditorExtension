/**
 * M3 手工指定图位素材：`slot-picks`。
 *
 * 这一组守的是"覆盖层不抢自动路径的活"：自动分配先跑出来，用户点名的槽位才被替换；
 * 没点名的槽位一个字都不变。下面几条断言各自对应一个容易写错的判断 ——
 * 过期槽位要忽略而不是报错、同一张素材可以被点名两次、空串等于"自动"。
 */

import { describe, expect, it } from 'vitest';
import COLLAGE_SOURCE from '../../src/services/composition/templates/three_pose_figure_collage_white.v1.0.json';
import HERO_SOURCE from '../../src/services/composition/templates/hero_closeup_package_backdrop.v1.4.json';
import POSTER_SOURCE from '../../src/services/composition/templates/dramatic_glow_character_poster.v1.0.json';
import { parseLayoutTemplateOrThrow } from '../../src/services/composition/template-schema';
import {
  isPicked,
  pickableSlots,
  prunePicks,
  resolveSlotPicks,
} from '../../src/services/composition/slot-picks';

const POSTER = parseLayoutTemplateOrThrow(POSTER_SOURCE);
const COLLAGE = parseLayoutTemplateOrThrow(COLLAGE_SOURCE);
const HERO = parseLayoutTemplateOrThrow(HERO_SOURCE);

describe('pickableSlots', () => {
  it('lists the poster slots in render order', () => {
    expect(pickableSlots(POSTER).map((option) => option.slotId)).toEqual([
      'backdrop',
      'detail_inset',
      'hero_front',
    ]);
  });

  it('keeps hero and box in the same list as the photo slots', () => {
    const options = pickableSlots(HERO);
    expect(options.map((option) => option.role).sort()).toEqual(['box', 'hero']);
    expect(options.map((option) => option.slotId).sort()).toEqual(['hero_closeup', 'package_backdrop']);
  });

  it('covers every slot the schema accepts — a valid slot always has somewhere to stand', () => {
    // 解析器本来就要求"每个槽位都要有 closeup 或 variants"，所以过滤条件在真实模板上
    // 不会漏掉任何一格；这条用例钉的是"面板列出的图位 = 排版会画的图位"，将来若有人
    // 放宽解析规则，这里会先红。
    for (const template of [POSTER, COLLAGE, HERO]) {
      expect(pickableSlots(template).map((option) => option.slotId).sort()).toEqual(
        template.slots.map((slot) => slot.id).sort(),
      );
    }
  });

  it('carries allow_source_reuse through, so the panel could warn about it', () => {
    const backdrop = pickableSlots(POSTER).find((option) => option.slotId === 'backdrop');
    const inset = pickableSlots(POSTER).find((option) => option.slotId === 'detail_inset');
    expect(backdrop?.allowSourceReuse).toBe(true);
    expect(inset?.allowSourceReuse).toBe(false);
  });
});

describe('resolveSlotPicks', () => {
  it('splits hero, box and support picks into the three channels', () => {
    const plan = resolveSlotPicks({
      template: POSTER,
      picks: { hero_front: 'mat-1', detail_inset: 'mat-2' },
    });
    expect(plan.heroMaterialId).toBe('mat-1');
    expect(plan.boxMaterialId).toBeNull();
    expect(plan.supports).toEqual([{ slotId: 'detail_inset', materialId: 'mat-2' }]);
    expect(plan.ignored).toEqual([]);
  });

  it('treats empty strings, null and blanks as "automatic"', () => {
    const plan = resolveSlotPicks({
      template: POSTER,
      picks: { hero_front: '', detail_inset: '   ', backdrop: null },
    });
    expect(plan).toEqual({ heroMaterialId: null, boxMaterialId: null, supports: [], ignored: [] });
  });

  it('reports slot ids it cannot use instead of guessing', () => {
    const plan = resolveSlotPicks({
      template: POSTER,
      picks: { 'gone-slot': 'mat-1', model_top_left: 'mat-2', detail_inset: 'mat-3' },
    });
    // `model_top_left` 是文字区：点名它是错的，但只忽略这一格，别让整次排版失败。
    expect(plan.ignored.sort()).toEqual(['gone-slot', 'model_top_left']);
    expect(plan.supports).toEqual([{ slotId: 'detail_inset', materialId: 'mat-3' }]);
  });

  it('lets the same material be named twice — dedupe is an automatic-path rule', () => {
    const plan = resolveSlotPicks({
      template: POSTER,
      picks: { backdrop: 'mat-1', detail_inset: 'mat-1' },
    });
    expect(plan.supports.map((entry) => entry.materialId)).toEqual(['mat-1', 'mat-1']);
  });

  it('orders support picks the way they paint: backdrop first, inset after', () => {
    const plan = resolveSlotPicks({
      template: POSTER,
      picks: { detail_inset: 'mat-2', backdrop: 'mat-1' },
    });
    expect(plan.supports.map((entry) => entry.slotId)).toEqual(['backdrop', 'detail_inset']);
  });

  it('trims the material id it stores, so the lookup cannot miss on a stray space', () => {
    const plan = resolveSlotPicks({ template: COLLAGE, picks: { rear_view_background: ' mat-9 ' } });
    expect(plan.supports).toEqual([{ slotId: 'rear_view_background', materialId: 'mat-9' }]);
  });
});

describe('prunePicks', () => {
  it('keeps the picks that still exist after a template switch', () => {
    expect(prunePicks({ detail_inset: 'mat-1' }, POSTER)).toEqual({ detail_inset: 'mat-1' });
  });

  it('drops ids that belong to another template', () => {
    const kept = prunePicks({ detail_inset: 'mat-1', rear_view_background: 'mat-2' }, POSTER);
    expect(kept).toEqual({ detail_inset: 'mat-1' });
    // 反过来也一样：换到拼贴模板，海报的三个槽位都要消失。
    expect(prunePicks({ detail_inset: 'mat-1', backdrop: 'mat-2' }, COLLAGE)).toEqual({});
  });

  it('drops blanks and nulls so the panel does not show a "picked" row', () => {
    expect(prunePicks({ detail_inset: '', backdrop: null, hero_front: '  ' }, POSTER)).toEqual({});
  });
});

describe('isPicked', () => {
  it('counts a named slot as picked, a blank as not', () => {
    expect(isPicked({ detail_inset: 'mat-1' }, 'detail_inset')).toBe(true);
    expect(isPicked({ detail_inset: '  ' }, 'detail_inset')).toBe(false);
    expect(isPicked({}, 'detail_inset')).toBe(false);
  });
});
