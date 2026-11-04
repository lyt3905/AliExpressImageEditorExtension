/**
 * Template registry.
 *
 * The JSON files are the source of truth and are imported as data (Vite and
 * Vitest both handle JSON imports natively, and `resolveJsonModule` is on).
 * Nothing here hardcodes template numbers — `version` bumps land as new files.
 *
 * Keys are `id@version` so the same id can exist several times while a new
 * version is being tried out. `DEFAULT_TEMPLATE_KEY` is what the editor uses
 * until the compose panel lets the user choose.
 */

import heroCloseupV14 from './hero_closeup_package_backdrop.v1.4.json';
import threePoseV10 from './three_pose_figure_collage_white.v1.0.json';
import dramaticGlowV10 from './dramatic_glow_character_poster.v1.0.json';
import {
  parseLayoutTemplate,
  type TemplateParseResult,
} from '../template-schema';
import type { LayoutTemplate } from '../types';

export const TEMPLATE_SOURCES: Readonly<Record<string, unknown>> = {
  'hero_closeup_package_backdrop@1.4': heroCloseupV14,
  'three_pose_figure_collage_white@1.0': threePoseV10,
  'dramatic_glow_character_poster@1.0': dramaticGlowV10,
};

export const DEFAULT_TEMPLATE_KEY = 'hero_closeup_package_backdrop@1.4';

/**
 * 模板在界面上的中文名，按 **id** 记（不是 `id@version`）。
 *
 * 键用 id 而不是完整 key，是为了让版本升级（新增 `xxx.v1.5.json`）不用再补一次
 * 名字——升级换的是文件，模板本身还是那一个。没登记过的 id 在界面上回落到 id 本身，
 * 所以新增模板忘了起名只会看到英文 id，不会渲染成空白。
 *
 * 名字刻意写得短：它出现在一个 240px 宽的下拉框里，后面还跟着版本号与「（草稿）」。
 */
export const TEMPLATE_TITLES: Readonly<Record<string, string>> = {
  hero_closeup_package_backdrop: '主体特写 + 包装盒背板',
  three_pose_figure_collage_white: '三姿态拼贴（白底）',
  dramatic_glow_character_poster: '深色发光海报',
};

/** 界面上显示的名字；未登记的模板回落成 id（不会显示空白）。 */
export function templateTitle(id: string): string {
  return TEMPLATE_TITLES[id] ?? id;
}

export function templateKey(template: Pick<LayoutTemplate, 'id' | 'version'>): string {
  return `${template.id}@${template.version}`;
}

export function listTemplateKeys(): string[] {
  return Object.keys(TEMPLATE_SOURCES);
}

/** Parse one registered template; returns the validator's full result. */
export function parseTemplateByKey(key: string): TemplateParseResult {
  const source = TEMPLATE_SOURCES[key];
  if (source === undefined) {
    return {
      template: null,
      issues: [{ path: '', message: `未注册的模板：${key}（已注册：${listTemplateKeys().join(', ')}）` }],
      warnings: [],
    };
  }
  return parseLayoutTemplate(source);
}

/** Parse every registered template — used by the lint test and the panel's picker. */
export function parseAllTemplates(): Array<{ key: string } & TemplateParseResult> {
  return listTemplateKeys().map((key) => ({ key, ...parseTemplateByKey(key) }));
}
