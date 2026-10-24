/**
 * Remembered placement of the auto-added product-code text layer.
 *
 * The same trade as `text-defaults.ts`: a global preference, not document
 * state. The seller moves the code where they like it once, and every future
 * session's auto-added code starts from there instead of the fixed top.
 *
 * `scale` rides along because the code is often resized with the transformer;
 * remembering only x/y would reset the size the seller settled on.
 */

import { STORAGE_KEYS } from '../shared/constants';
import { CANVAS_SIZE, TEXT_LAYER_DEFAULTS } from '../shared/constants';

export interface CodePlacement {
  x: number;
  y: number;
  scale: number;
}

export const DEFAULT_CODE_PLACEMENT: CodePlacement = {
  x: CANVAS_SIZE / 2,
  y: 48,
  scale: 1,
};

function sanitize(value: unknown): CodePlacement {
  const candidate = value as Partial<CodePlacement> | null | undefined;
  const numberOr = (raw: unknown, fallback: number): number =>
    typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return {
    x: numberOr(candidate?.x, DEFAULT_CODE_PLACEMENT.x),
    y: numberOr(candidate?.y, DEFAULT_CODE_PLACEMENT.y),
    scale: Math.max(
      0.05,
      numberOr(candidate?.scale, TEXT_LAYER_DEFAULTS.scale),
    ),
  };
}

export async function loadCodePlacement(): Promise<CodePlacement> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.codePlacement);
    return sanitize(stored?.[STORAGE_KEYS.codePlacement]);
  } catch {
    return { ...DEFAULT_CODE_PLACEMENT };
  }
}

export async function saveCodePlacement(next: CodePlacement): Promise<void> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.codePlacement]: sanitize(next) });
  } catch {
    /* not remembered — the default placement is used next time */
  }
}
