import { describe, expect, it } from 'vitest';
import {
  backgroundOf,
  hasCustomBackground,
  normalizeBackgroundColor,
} from '../../src/services/document-background';
import { DEFAULT_DOCUMENT_BACKGROUND } from '../../src/shared/constants';
import type { EditorDocument } from '../../src/shared/types';

/**
 * 画布背景是**文档属性**（10.23.0）：海报模板铺的是 `#171719`，白底模板仍是白色。
 *
 * 这一组只测"值怎么写进文档、写坏了怎么办" —— 它必须有确定的兜底，因为存进
 * `chrome.storage` 再读回来时，任何一次手工改动都可能留下 `rgb(...)`、大写、
 * 或者干脆没有这个字段（旧文档）。
 */
describe('normalizeBackgroundColor', () => {
  it('keeps a six digit hex and lowercases it', () => {
    expect(normalizeBackgroundColor('#171719')).toBe('#171719');
    expect(normalizeBackgroundColor('#171719'.toUpperCase())).toBe('#171719');
  });

  it('expands the short form instead of dropping it', () => {
    expect(normalizeBackgroundColor('#abc')).toBe('#aabbcc');
  });

  it('accepts a value without the leading hash', () => {
    expect(normalizeBackgroundColor('171719')).toBe('#171719');
  });

  it('trims whitespace around the value', () => {
    expect(normalizeBackgroundColor('  #0e0e10  ')).toBe('#0e0e10');
  });

  it('falls back to white for anything it cannot read', () => {
    for (const value of [undefined, null, 42, {}, [], '', '#12345', '#1234567', 'red', 'rgb(1,2,3)']) {
      expect(normalizeBackgroundColor(value)).toBe(DEFAULT_DOCUMENT_BACKGROUND);
    }
  });
});

describe('backgroundOf / hasCustomBackground', () => {
  const document = (patch: Partial<EditorDocument> = {}): EditorDocument => ({ layers: [], ...patch });

  it('reports white when the document has no background field', () => {
    expect(backgroundOf(document())).toBe('#ffffff');
    expect(hasCustomBackground(document())).toBe(false);
  });

  it('reports the stored colour', () => {
    expect(backgroundOf(document({ background: '#171719' }))).toBe('#171719');
    expect(hasCustomBackground(document({ background: '#171719' }))).toBe(true);
  });

  it('normalizes a broken stored colour instead of painting it', () => {
    expect(backgroundOf(document({ background: 'nope' }))).toBe('#ffffff');
    expect(hasCustomBackground(document({ background: '#FFF' }))).toBe(false);
  });
});
