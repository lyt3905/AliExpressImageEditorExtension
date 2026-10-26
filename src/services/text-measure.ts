/**
 * Real glyph measurement for the text-zone fitter.
 *
 * `text-fit.ts` takes a `MeasureText` port so it can run under Node; this is the
 * DOM implementation. One canvas and one context are reused: creating a 2D
 * context per call would show up immediately, because the fitter measures every
 * candidate font size.
 */

import type { MeasureText } from './composition/text-fit';

let scratch: CanvasRenderingContext2D | null = null;

function context(): CanvasRenderingContext2D | null {
  if (scratch) return scratch;
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 8;
  scratch = canvas.getContext('2d');
  return scratch;
}

export function measureTextWithCanvas(): MeasureText {
  return (text, font) => {
    if (!text) return 0;
    const ctx = context();
    if (!ctx) {
      // No DOM (tests, or a very odd context): fall back to a fixed advance. It is
      // wrong by a few percent, but a text zone that renders slightly small beats
      // one that throws and takes the whole composition down.
      return text.length * font.size * 0.6;
    }
    ctx.font = `${font.weight === 'bold' ? '700' : '400'} ${font.size}px ${quoteFamily(font.family)}`;
    return ctx.measureText(text).width;
  };
}

/**
 * Quote a family name so families with spaces (`Microsoft YaHei`) parse as one
 * unit. Generic names (`serif`) must stay unquoted.
 */
function quoteFamily(family: string): string {
  const generic = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui']);
  const trimmed = family.trim();
  if (generic.has(trimmed.toLowerCase())) return trimmed;
  return `"${trimmed.replaceAll('"', '')}"`;
}
