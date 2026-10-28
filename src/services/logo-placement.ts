/**
 * Remembered placement of each brand's logo, so the seller drags it into place once.
 *
 * Same trade as `text-defaults.ts` / `code-placement.ts`: a global preference, not
 * document state. One entry per brand id (not one shared entry) — logos differ
 * wildly in aspect ratio (a wordmark is 5:1, a mascot is 1:1), and a single shared
 * placement would put one of them half off the canvas.
 *
 * `scale` rides along with x/y because the logo is resized with the transformer;
 * remembering only the position would reset the size on every session.
 */

import {
  CANVAS_SIZE,
  LOGO_DEFAULT_LONGEST_RATIO,
  LOGO_MARGIN,
  LOGO_MAX_SCALE,
  LOGO_MIN_SCALE,
  STORAGE_KEYS,
} from '../shared/constants';

export interface LogoPlacement {
  x: number;
  y: number;
  scale: number;
}

/** brandId → placement. A brand without an entry still has to be placed somehow. */
export type LogoPlacementMap = Record<string, LogoPlacement>;

/**
 * Where a logo goes the first time: bottom-right corner, capped to
 * `LOGO_DEFAULT_LONGEST_RATIO` of the canvas.
 *
 * Bottom-right on purpose — it is the corner sellers put a brand stamp in, and it
 * is away from the product code (top) and the watermark (centred).
 */
export function defaultLogoPlacement(width: number, height: number): LogoPlacement {
  const sourceWidth = width > 0 ? width : CANVAS_SIZE;
  const sourceHeight = height > 0 ? height : CANVAS_SIZE;
  const longest = Math.max(sourceWidth, sourceHeight);
  const scale = longest > 0 ? (CANVAS_SIZE * LOGO_DEFAULT_LONGEST_RATIO) / longest : 1;
  return {
    x: CANVAS_SIZE - LOGO_MARGIN - (sourceWidth * scale) / 2,
    y: CANVAS_SIZE - LOGO_MARGIN - (sourceHeight * scale) / 2,
    scale,
  };
}

function numberOr(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

function sanitizePlacement(value: unknown, fallback: LogoPlacement): LogoPlacement {
  const candidate = value as Partial<LogoPlacement> | null | undefined;
  return {
    x: numberOr(candidate?.x, fallback.x),
    y: numberOr(candidate?.y, fallback.y),
    scale: Math.min(LOGO_MAX_SCALE, Math.max(LOGO_MIN_SCALE, numberOr(candidate?.scale, fallback.scale))),
  };
}

/** Shape-check a stored map; a broken map reads as "nothing remembered yet". */
export function parseLogoPlacementMap(value: unknown): LogoPlacementMap {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const map: LogoPlacementMap = {};
  for (const [brandId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!brandId) continue;
    const candidate = entry as Partial<LogoPlacement> | null | undefined;
    if (!candidate || typeof candidate !== 'object') continue;
    if (typeof candidate.x !== 'number' || typeof candidate.y !== 'number') continue;
    if (typeof candidate.scale !== 'number' || !Number.isFinite(candidate.scale)) continue;
    map[brandId] = {
      x: candidate.x,
      y: candidate.y,
      scale: Math.min(LOGO_MAX_SCALE, Math.max(LOGO_MIN_SCALE, candidate.scale)),
    };
  }
  return map;
}

export async function loadLogoPlacements(): Promise<LogoPlacementMap> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.logoPlacement);
    return parseLogoPlacementMap(stored?.[STORAGE_KEYS.logoPlacement]);
  } catch {
    return {};
  }
}

/**
 * Write one brand's placement back, keeping the other brands' entries.
 *
 * Read-modify-write rather than a cached copy: the panel commits on every
 * drag/resize of a logo, and two editor tabs on different products must not
 * clobber each other's brands.
 */
export async function saveLogoPlacement(brandId: string, placement: LogoPlacement): Promise<void> {
  if (!brandId) return;
  try {
    const map = await loadLogoPlacements();
    map[brandId] = sanitizePlacement(placement, defaultLogoPlacement(1, 1));
    await chrome.storage.local.set({ [STORAGE_KEYS.logoPlacement]: map });
  } catch {
    /* not remembered — the default corner is used next time */
  }
}
