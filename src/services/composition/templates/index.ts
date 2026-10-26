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
import {
  parseLayoutTemplate,
  type TemplateParseResult,
} from '../template-schema';
import type { LayoutTemplate } from '../types';

export const TEMPLATE_SOURCES: Readonly<Record<string, unknown>> = {
  'hero_closeup_package_backdrop@1.4': heroCloseupV14,
};

export const DEFAULT_TEMPLATE_KEY = 'hero_closeup_package_backdrop@1.4';

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
