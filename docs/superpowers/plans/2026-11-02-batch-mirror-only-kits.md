# 全部镜像与 Only Kits 图层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加一次撤销的图片批量水平镜像，并根据标题自动创建不遮挡编号的 `Only Kits` 文字层。

**Architecture:** 批量镜像作为 editor reducer 的原子 action；标题识别和伴随文字层构造保持为纯函数。编辑器 hydrate 与自动排版保留路径只负责调用这些纯函数和去重。

**Tech Stack:** TypeScript、React、Konva、Vitest、Chrome MV3

**Spec:** `docs/superpowers/specs/2026-11-02-batch-mirror-only-kits-design.md`

## Global Constraints

- `src/` 改动必须执行 `npm run version:bump patch`，三处版本号保持一致。
- “全部镜像”只处理 `original` 与 `cutout`，整批只产生一条撤销记录。
- 标题只按不区分大小写的完整单词 `kit` / `kits` 判断。
- `Only Kits` 不得遮挡编号；没有编号时占用编号默认位置。
- 最小验证为 `npm run typecheck`、`npm test`、`npm run check:version`。

## Review Focus

- 空画布点击全部镜像必须保持 state 引用和历史不变。
- 已镜像与未镜像图片混合时，各图层分别切换当前 `flipX`。
- `toolkit`、`kitchen` 等包含字串不得误命中。
- 保存文档已有 `Only Kits` 时不得重复创建。
- 自动排版后编号与 `Only Kits` 均不得丢失。

---

### Task 1: 原子批量镜像

**Files:**
- Modify: `src/editor/state/editor-reducer.ts`
- Modify: `src/editor/components/TransformControls.tsx`
- Modify: `src/editor/components/LayerPanel.tsx`
- Modify: `src/editor/App.tsx`
- Test: `tests/unit/editor-reducer.test.ts`

**Interfaces:**
- Produces: `EditorAction` 的 `{ type: 'FLIP_ALL_IMAGES_X' }` 及 `LayerPanelProps.onFlipAllImages()`。

- [x] **Step 1: 写失败测试**：断言原图与抠图的 `flipX` 分别切换，其他种类不变，只增加一条 history；空画布不产生 history。
- [x] **Step 2: 运行 `npm test -- tests/unit/editor-reducer.test.ts`**，确认因 action 尚不存在而失败。
- [x] **Step 3: 实现 reducer action，并把“垂直镜像”按钮改为“全部镜像”调用批量回调；现有“水平镜像”保持不变。**
- [x] **Step 4: 重跑定向测试并确认通过。**

### Task 2: 标题识别与 Only Kits 图层

**Files:**
- Modify: `src/content/aliexpress-page-adapter.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/content/content-script.ts`
- Modify: `src/background/service-worker.ts`
- Modify: `src/background/session-manager.ts`
- Modify: `src/editor/state/editor-reducer.ts`
- Modify: `src/editor/App.tsx`
- Modify: `src/editor/state/compose-emit.ts`
- Test: `tests/unit/product-code.test.ts`
- Test: `tests/unit/text-layer.test.ts`
- Test: `tests/unit/compose-emit.test.ts`

**Interfaces:**
- Produces: `AliExpressPageAdapter.hasKitsTitle(): boolean`、会话字段 `onlyKits?: boolean`、`createOnlyKitsTextLayer(codeLayer?, defaults?, placement?): TextLayer`。
- Consumes: 编号层构造器、文字测量能力和现有会话传递链路。

- [x] **Step 1: 写失败测试**：覆盖 `kit`/`kits` 大小写命中、字串误命中，以及会话无编号时仍携带标记。
- [x] **Step 2: 运行 `npm test -- tests/unit/product-code.test.ts`**，确认新接口缺失导致失败。
- [x] **Step 3: 实现纯标题判断并把布尔标记沿 content → background → session 传入编辑器。**
- [x] **Step 4: 写失败测试**：有编号时样式一致、水平中心一致、边界留间距且不重叠；无编号时使用编号默认位置；已有图层不重复。
- [x] **Step 5: 运行文字层定向测试，确认构造器缺失导致失败。**
- [x] **Step 6: 实现 `Only Kits` 构造、hydrate 去重和默认位置逻辑。**
- [x] **Step 7: 写并运行失败测试，证明自动排版保留编号和 `Only Kits`；随后扩展 `carriedLayers` 并重跑通过。**

### Task 3: 版本与完整验证

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `public/manifest.json`

**Interfaces:**
- Consumes: Tasks 1–2 的完整实现。

- [x] **Step 1: 运行 `npm run version:bump patch`，不得手工分别改三处版本。**
- [x] **Step 2: 运行 `npm run typecheck`。**
- [x] **Step 3: 运行 `npm test`。**
- [x] **Step 4: 运行 `npm run check:version`。**
- [x] **Step 5: 检查 `git diff --check` 和最终 diff，确认没有无关改动、密钥或 `dist/`。**
