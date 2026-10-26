/**
 * Text-zone fitting.
 *
 * The template gives a rect, an alignment and `max_lines` — not a font size. The
 * size has to be derived from the string, because the same zone holds `A7` and
 * `GX-2200-BLK-01`: at a fixed 48px the first looks lost and the second overflows.
 *
 * Measurement is injected (`MeasureText`) for the same reason the alpha probe is:
 * the solver has to run under `environment: 'node'`, where there is no canvas.
 */

export type MeasureText = (
  text: string,
  font: { family: string; size: number; weight: 'normal' | 'bold' },
) => number;

export interface TextFitRequest {
  text: string;
  maxWidth: number;
  maxHeight: number;
  fontFamily: string;
  weight: 'normal' | 'bold';
  maxLines: number;
  minFontSize: number;
  maxFontSize: number;
  measure: MeasureText;
}

export interface TextFitResult {
  fontSize: number;
  lines: string[];
  /** Widest rendered line, logical px. */
  width: number;
  height: number;
  /** False when even `minFontSize` could not fit — the caller decides what to show. */
  fits: boolean;
}

/** Konva's default `lineHeight` is 1, so a line is exactly one font size tall. */
export const TEXT_LINE_HEIGHT = 1;

/**
 * Greedy wrap, preferring to break at the last space.
 *
 * Character-by-character is deliberate: model codes are Latin-with-dashes and CJK
 * titles are unspaced, and a word-based wrapper silently overflows on both.
 */
function wrapText(request: TextFitRequest, fontSize: number): string[] {
  const { text, maxWidth, fontFamily, weight, measure } = request;
  const font = { family: fontFamily, size: fontSize, weight };
  const lines: string[] = [];

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }
    let line = '';
    for (const char of paragraph) {
      const candidate = line + char;
      if (line !== '' && measure(candidate, font) > maxWidth) {
        const lastSpace = line.lastIndexOf(' ');
        if (lastSpace > 0 && char !== ' ') {
          lines.push(line.slice(0, lastSpace));
          line = `${line.slice(lastSpace + 1)}${char}`;
        } else {
          lines.push(line);
          line = char;
        }
      } else {
        line = candidate;
      }
    }
    lines.push(line);
  }
  return lines;
}

function attempt(request: TextFitRequest, fontSize: number): TextFitResult {
  const lines = wrapText(request, fontSize);
  const font = { family: request.fontFamily, size: fontSize, weight: request.weight };
  const width = lines.reduce((widest, line) => Math.max(widest, request.measure(line, font)), 0);
  const height = lines.length * fontSize * TEXT_LINE_HEIGHT;
  const fits = lines.length <= request.maxLines && height <= request.maxHeight && width <= request.maxWidth;
  return { fontSize, lines, width, height, fits };
}

/**
 * Largest integer font size that fits the zone.
 *
 * Integer sizes on purpose: a fractional size produces sub-pixel glyph placement
 * that differs between preview and export, and the difference is visible on a
 * 800x800 canvas.
 */
export function fitTextToBox(request: TextFitRequest): TextFitResult {
  const min = Math.max(1, Math.ceil(request.minFontSize));
  const max = Math.max(min, Math.floor(request.maxFontSize));

  let low = min;
  let high = max;
  let best: TextFitResult | null = null;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = attempt(request, middle);
    if (candidate.fits) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  if (best) return best;

  // Nothing fits. Return the smallest size with the lines truncated to the zone so
  // the caller can still render something recognisable plus a warning.
  const smallest = attempt(request, min);
  return {
    ...smallest,
    lines: smallest.lines.slice(0, Math.max(1, request.maxLines)),
    fits: false,
  };
}

export interface FontStyleSpec {
  family: string;
  weight: 'normal' | 'bold';
  fill: string;
}

const SERIF_FAMILIES = ['SimSun', 'serif'];
const SANS_FAMILIES = ['Microsoft YaHei', 'Arial', 'sans-serif'];

/**
 * Interpret a `font_style` string like `black_bold_serif`.
 *
 * Parsed by token rather than by an exact-match table: a future template will
 * write `white_bold_sans` and it should work without touching this function.
 * Unrecognised tokens fall back to the text layer defaults instead of throwing —
 * an odd colour name is not a reason to refuse to draw the code.
 */
export function parseFontStyleSpec(spec: string): FontStyleSpec {
  const tokens = spec.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const isSerif = tokens.includes('serif');
  const isSans = tokens.includes('sans') || tokens.includes('sans-serif');
  const family = isSerif ? SERIF_FAMILIES[1] : isSans ? SANS_FAMILIES[0] : SANS_FAMILIES[0];
  const weight: 'normal' | 'bold' = tokens.includes('bold') ? 'bold' : 'normal';

  let fill = '#000000';
  if (tokens.includes('white')) fill = '#FFFFFF';
  else if (tokens.includes('red')) fill = '#D0021B';
  else if (tokens.includes('gray') || tokens.includes('grey')) fill = '#666666';

  return { family, weight, fill };
}

export interface TextLayerGeometry {
  /** Node centre X (the layer model is centre-anchored). */
  x: number;
  /** Node centre Y. */
  y: number;
  /** Wrap width — equal to the zone width, so `align` behaves as authored. */
  width: number;
  fontSize: number;
  align: 'left' | 'center' | 'right';
}

/**
 * Map a fitted text block into the layer model.
 *
 * `x` is the zone's horizontal centre while `width` spans the zone: with
 * `offsetX = width / 2` that puts the block's left edge exactly on the zone's left
 * edge, so `align: 'left'` means what the template author meant.
 *
 * Vertically the block is top-aligned inside the zone. Centring it instead would
 * move the code every time its length changes, which reads as jitter between
 * regenerations of the same product.
 */
export function textLayerGeometry(
  zone: { box: readonly [number, number, number, number]; align: 'left' | 'center' | 'right' },
  fit: TextFitResult,
): TextLayerGeometry {
  const [left, top, right] = zone.box;
  const width = right - left;
  return {
    x: left + width / 2,
    y: top + fit.height / 2,
    width,
    fontSize: fit.fontSize,
    align: zone.align,
  };
}
