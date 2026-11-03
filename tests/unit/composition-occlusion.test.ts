/**
 * 遮挡率必须是"两块 alpha 真的叠在一起"，不是"前景落在后景的包围盒里"。
 *
 * 2026-11-03 的复核给出的最小反例：两张 100×100 的图片放在同一位置，2×2 掩码分别是
 * `[1,0,0,1]` 与 `[0,1,1,0]` —— 有效内容完全不重叠，旧实现却报 100% 被遮。
 */

import { describe, expect, it } from 'vitest';
import HERO_SOURCE from '../../src/services/composition/templates/hero_closeup_package_backdrop.v1.4.json';
import { createAlphaProfile } from '../../src/services/composition/alpha';
import { occlusionRatio, zoneIntrusion } from '../../src/services/composition/coverage';
import type { CanvasSize, ContentPlacement } from '../../src/services/composition/coverage';
import { buildCompositionPlan } from '../../src/services/composition/planner';
import { parseLayoutTemplateOrThrow } from '../../src/services/composition/template-schema';

const CANVAS: CanvasSize = { width: 800, height: 800 };
const AT: ContentPlacement = { centerX: 400, centerY: 400, scale: 1 };

function mask(values: number[]) {
  return createAlphaProfile({ sourceWidth: 100, sourceHeight: 100, maskSize: 2, mask: values });
}

describe('occlusionRatio', () => {
  it('reports zero when the two alpha shapes do not overlap at all', () => {
    const back = mask([1, 0, 0, 1]);
    const front = mask([0, 1, 1, 0]);
    const ratio = occlusionRatio(
      { profile: front, placement: AT },
      { profile: back, placement: AT },
      CANVAS,
    );
    expect(ratio).toBeLessThan(0.02);
  });

  it('does not miss stripe-shaped masks when the back mask is fine-grained', () => {
    // 复核 R3 的第二个反例：128×128、偶数列不透明（density 0.5078），前面压一张完全
    // 不透明的同尺寸图 —— 真实可见率是 0，而 64 格采样会跳过绝大多数列，报 ~97%。
    const columns = 128;
    const stripes: number[] = [];
    for (let row = 0; row < columns; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        stripes.push(column % 2 === 0 ? 1 : 0);
      }
    }
    const back = createAlphaProfile({
      sourceWidth: 128,
      sourceHeight: 128,
      maskSize: columns,
      mask: stripes,
    });
    const front = createAlphaProfile({ sourceWidth: 128, sourceHeight: 128, maskSize: 1, mask: [1] });
    const ratio = occlusionRatio(
      { profile: front, placement: AT },
      { profile: back, placement: AT },
      CANVAS,
    );
    expect(ratio).toBeGreaterThan(0.98);
  });

  it('still reports a fully covered layer as hidden', () => {
    const back = mask([1, 1, 1, 1]);
    const front = mask([1, 1, 1, 1]);
    const ratio = occlusionRatio(
      { profile: front, placement: AT },
      { profile: back, placement: AT },
      CANVAS,
    );
    expect(ratio).toBeGreaterThan(0.98);
  });

  it('counts only the overlapping opaque cells', () => {
    const back = mask([1, 1, 1, 1]);
    const front = mask([0, 0, 1, 1]);
    const ratio = occlusionRatio(
      { profile: front, placement: AT },
      { profile: back, placement: AT },
      CANVAS,
    );
    // Half of the box's cells are opaque under an equally opaque front layer.
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });

  it('ignores a front layer that sits somewhere else entirely', () => {
    const back = mask([1, 1, 1, 1]);
    const front = mask([1, 1, 1, 1]);
    const ratio = occlusionRatio(
      { profile: front, placement: { ...AT, centerX: 100 } },
      { profile: back, placement: AT },
      CANVAS,
    );
    expect(ratio).toBe(0);
  });

  it('does not skip a fine front mask simply because the back mask is coarse', () => {
    /*
      三次复核 R3 的反例：前景 128×128（第 0 列与奇数列不透明，density 65/128），后景
      128×2 全不透明、maskSize 只有 2。10.22.3 的算法只在后景 2×2 单元的中心查询前景，
      查询点正好落在透明的偶数列上 → 报 0 遮挡，而真实遮挡率是 50.78%。
      现在按两个掩码网格的**细化**做面积积分，细的那一层不会被粗的采样步长跨过去。
    */
    const columns = 128;
    const stripes: number[] = [];
    for (let row = 0; row < columns; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        stripes.push(column === 0 || column % 2 === 1 ? 1 : 0);
      }
    }
    const front = createAlphaProfile({
      sourceWidth: 128,
      sourceHeight: 128,
      maskSize: columns,
      mask: stripes,
    });
    const back = createAlphaProfile({
      sourceWidth: 128,
      sourceHeight: 2,
      maskSize: 2,
      mask: [1, 1, 1, 1],
    });
    const ratio = occlusionRatio(
      { profile: front, placement: AT },
      { profile: back, placement: AT },
      CANVAS,
    );
    expect(ratio).toBeGreaterThan(0.48);
    expect(ratio).toBeLessThan(0.53);
  });

  it('integrates the real overlap area when both masks are single cells', () => {
    // 三次复核 R3 的第二个反例：maskSize=1 的两张 100×100，盖住左边 49px 时旧实现报 0%、
    // 盖 51px 时报 100%。一个采样点代表整个交集，注定只能二选一。
    const solid = (width: number, height: number) =>
      createAlphaProfile({ sourceWidth: width, sourceHeight: height, maskSize: 1, mask: [1] });
    const back = solid(100, 100);
    const left49 = occlusionRatio(
      { profile: solid(100, 100), placement: { ...AT, centerX: 349 } },
      { profile: back, placement: AT },
      CANVAS,
    );
    const left51 = occlusionRatio(
      { profile: solid(100, 100), placement: { ...AT, centerX: 351 } },
      { profile: back, placement: AT },
      CANVAS,
    );
    expect(left49).toBeGreaterThan(0.47);
    expect(left49).toBeLessThan(0.51);
    expect(left51).toBeGreaterThan(0.49);
    expect(left51).toBeLessThan(0.53);
  });

  it('keeps every mask boundary when two 128-cell combs overlap by half a pixel', () => {
    /*
      四次复核 R3 的反例，也是 10.22.4 唯一仍失败的一处：两张 128×128、maskSize 都是 128，
      前景不透明列为「第 0 列 + 奇数列」，后景为「偶数列 + 最后一列」，水平错开 0.49px。
      精确结果是可见率 0.5094、遮挡率 0.4906；10.22.4 把合并后的 256 条边砍到 200 条，
      被合并的矩形里 alpha 不再恒定、却仍取中心值 → 遮挡率报 0.2645（可见率 0.7355），
      22.6 个百分点。细化**不许丢边**，这条锁住它。
    */
    const columns = 128;
    const comb = (opaque: (column: number) => boolean) => {
      const mask: number[] = [];
      for (let row = 0; row < columns; row += 1) {
        for (let column = 0; column < columns; column += 1) mask.push(opaque(column) ? 1 : 0);
      }
      return createAlphaProfile({
        sourceWidth: columns,
        sourceHeight: columns,
        maskSize: columns,
        mask,
      });
    };
    const front = comb((column) => column === 0 || column % 2 === 1);
    const back = comb((column) => column % 2 === 0 || column === columns - 1);
    const ratio = occlusionRatio(
      { profile: front, placement: { ...AT, centerX: 400.49 } },
      { profile: back, placement: AT },
      CANVAS,
    );
    // 精确值 0.4906（可见率 0.5094）—— 给 2 个百分点的容差，但绝不允许回到 0.26。
    expect(ratio).toBeGreaterThan(0.47);
    expect(ratio).toBeLessThan(0.51);
  });
});

describe('zoneIntrusion', () => {
  const ZONE: [number, number, number, number] = [0, 712, 800, 800];

  it('measures how deep a thin hero cuts into the footer, not just its area share', () => {
    const thin = createAlphaProfile({
      sourceWidth: 20,
      sourceHeight: 2000,
      maskSize: 1,
      mask: [1],
    });
    // 高 2000 的主体缩放到 1344px，中心在 520 → 内容从 -152 到 1192，扎进底栏 88px。
    const { depth, covered } = zoneIntrusion(
      thin,
      { centerX: 400, centerY: 520, scale: 0.672 },
      ZONE,
      CANVAS,
    );
    expect(depth).toBeGreaterThan(6);
    // 面积份额小到 2% 阈值根本抓不住 —— 这正是要改用深度的原因。
    expect(covered).toBeLessThan(0.02);
  });

  it('reports the depth a 10px-wide hero cuts into the footer, not its own width', () => {
    // 复核 R7 第二个反例：主体变窄到 10px，交集短边是 5.8px（宽度），而它其实把
    // 88px 高的底栏整条切断了。深度必须按"进入保留区的方向"量。
    const slim = createAlphaProfile({
      sourceWidth: 10,
      sourceHeight: 2000,
      maskSize: 1,
      mask: [1],
    });
    const { depth, covered } = zoneIntrusion(
      slim,
      { centerX: 400, centerY: 520, scale: 0.58 },
      ZONE,
      CANVAS,
    );
    expect(depth).toBeGreaterThan(80);
    expect(covered).toBeLessThan(0.02);
  });

  it('treats a one-pixel edge graze as no intrusion worth reporting', () => {
    const wide = createAlphaProfile({
      sourceWidth: 800,
      sourceHeight: 800,
      maskSize: 1,
      mask: [1],
    });
    // 800px 高的方块，下边缘刚好压在 713 —— 只越过底栏 1px。
    const { depth } = zoneIntrusion(
      wide,
      { centerX: 400, centerY: 313, scale: 1 },
      ZONE,
      CANVAS,
    );
    expect(depth).toBeLessThan(6);
  });
});

describe('reserved zone warning', () => {
  it('fires on depth even when the thin hero only touches 2% of the footer', () => {
    // 把内置模板的底栏改成也管 hero（10.22.1 起内置模板只限制 box，这里显式造这个场景）。
    const source = JSON.parse(JSON.stringify(HERO_SOURCE)) as {
      canvas: { reserved_zones: Array<{ id: string; box: number[]; avoid_for: string[] }> };
    };
    source.canvas.reserved_zones = [
      { id: 'store_footer', box: [0, 712, 800, 800], avoid_for: ['hero'] },
    ];
    const template = parseLayoutTemplateOrThrow(source);

    const plan = buildCompositionPlan({
      template,
      hero: {
        materialId: 'material-thin',
        blobId: 'blob-thin',
        kind: 'cutout',
        profile: createAlphaProfile({
          sourceWidth: 20,
          sourceHeight: 2000,
          maskSize: 1,
          mask: [1],
        }),
        label: 'thin',
      },
      seed: 'MTS-0001',
    });

    const warning = plan.warnings.find((entry) => entry.code === 'reserved_zone_overlap');
    expect(warning).toBeDefined();
    // 面积份额仍在 2% 以下 —— 能报出来全靠深度判据。
    expect(Number(warning?.detail?.covered)).toBeLessThan(0.02);
    expect(Number(warning?.detail?.depth)).toBeGreaterThan(6);
  });
});
