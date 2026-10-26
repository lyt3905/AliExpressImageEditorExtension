/**
 * Alpha profiles: what the geometry solver knows about a material.
 *
 * The solver must not touch pixels. Decoding a 1600x1600 PNG per zoom candidate
 * would be hopeless, and it would make the whole thing untestable outside a
 * browser. So a material is summarised ONCE — as a trim box plus a small alpha
 * mask — and every later question ("how much of this is visible if I scale it by
 * 1.7 and pin its top edge at y=185?") is answered by arithmetic.
 *
 * Contract with the browser-side probe (`alpha-probe.ts`): the probe fills this
 * in from a real `OffscreenCanvas`; tests build it by hand.
 */

/** Opaque bounding box inside the source image, in SOURCE pixels. */
export interface TrimBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface AlphaProfile {
  /** Full source size (the cut-out PNG as stored), in pixels. */
  sourceWidth: number;
  sourceHeight: number;
  /** Where the actual product sits inside that canvas. */
  trim: TrimBox;
  /** Square mask resolution; `mask.length === maskSize * maskSize`. */
  maskSize: number;
  /** Row-major alpha coverage in [0, 1] over `trim`. */
  mask: readonly number[];
  /** Mean coverage over `trim` — "how solid is this product". */
  density: number;
}

export interface AlphaProfileInput {
  sourceWidth: number;
  sourceHeight: number;
  /** Defaults to the whole image. */
  trim?: TrimBox;
  maskSize: number;
  /** Defaults to fully opaque. */
  mask?: readonly number[];
}

export function createAlphaProfile(input: AlphaProfileInput): AlphaProfile {
  const { sourceWidth, sourceHeight, maskSize } = input;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) {
    throw new Error(`AlphaProfile: 源尺寸必须为正，实际 ${sourceWidth}×${sourceHeight}`);
  }
  if (!Number.isInteger(maskSize) || maskSize < 1) {
    throw new Error(`AlphaProfile: maskSize 必须是 ≥1 的整数，实际 ${maskSize}`);
  }

  const trim: TrimBox = input.trim ?? {
    left: 0,
    top: 0,
    width: sourceWidth,
    height: sourceHeight,
  };
  if (!(trim.width > 0) || !(trim.height > 0)) {
    throw new Error(`AlphaProfile: trim 宽高必须为正，实际 ${trim.width}×${trim.height}`);
  }
  if (trim.left < 0 || trim.top < 0 || trim.left + trim.width > sourceWidth || trim.top + trim.height > sourceHeight) {
    throw new Error(
      `AlphaProfile: trim ${JSON.stringify(trim)} 超出源尺寸 ${sourceWidth}×${sourceHeight}`,
    );
  }

  const cells = maskSize * maskSize;
  const mask = input.mask ?? new Array<number>(cells).fill(1);
  if (mask.length !== cells) {
    throw new Error(`AlphaProfile: mask 长度应为 ${cells}（${maskSize}²），实际 ${mask.length}`);
  }

  let sum = 0;
  const normalized = mask.map((value) => {
    const clamped = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
    sum += clamped;
    return clamped;
  });

  return {
    sourceWidth,
    sourceHeight,
    trim,
    maskSize,
    mask: normalized,
    density: sum / cells,
  };
}

/** A fully opaque rectangle — the common case for a real product photo. */
export function opaqueProfile(width: number, height: number, maskSize = 1): AlphaProfile {
  return createAlphaProfile({ sourceWidth: width, sourceHeight: height, maskSize });
}

export function maskCoverage(profile: AlphaProfile, column: number, row: number): number {
  return profile.mask[row * profile.maskSize + column] ?? 0;
}

/** True when the mask carries no shape information (a single uniform value). */
export function isUniformMask(profile: AlphaProfile): boolean {
  const first = profile.mask[0] ?? 0;
  return profile.mask.every((value) => value === first);
}
