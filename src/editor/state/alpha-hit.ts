/**
 * Alpha-accurate hit area for picture layers.
 *
 * ## Why not composite straight into the hit canvas
 *
 * Konva's default hit for an image is its whole rectangle, so a cut-out's
 * transparent background swallows every click meant for the picture underneath.
 * The obvious fix — draw the image into the hit canvas, then composite the hit
 * colour with `source-in` — is silently destructive, because **the hit canvas is
 * shared by every shape of the layer**:
 *
 * `source-in` is defined as "keep the source only where the destination already
 * has pixels". Inside the clip rectangle that means every destination pixel the
 * source does not cover ends up **transparent**. Shapes drawn earlier (the
 * pictures below, the plate) lose their hit pixels exactly under the upper
 * picture's bounding box — so the lower picture becomes unclickable precisely
 * where the upper one is transparent. Visible symptom: "上层的透明像素挡住了下层
 * 的图片，即使提前选中下层也点不中它".
 *
 * The fix is to build the mask **off to the side** and then paint it into the
 * shared hit canvas with plain `source-over`, which can only add pixels. Every
 * shape keeps whatever it registered before, and z-order decides the winner.
 *
 * The invariant this module guarantees: **painting a hit never removes a hit
 * pixel that is already there.**
 */

/** The slice of Konva's `Context` (HitContext) that hit painting needs. */
export interface HitPaintContext {
  save(): void;
  restore(): void;
  setAttr(attribute: string, value: unknown): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  /** Konva forwards the 3-argument form to the native `drawImage(image, dx, dy)`. */
  drawImage(image: CanvasImageSource, dx: number, dy: number): void;
}

/** The slice of a 2D context the offscreen mask needs. */
export type ScratchPaintContext = Pick<
  CanvasRenderingContext2D,
  'globalCompositeOperation' | 'fillStyle' | 'setTransform' | 'clearRect' | 'drawImage' | 'fillRect'
>;

/** An offscreen canvas plus its 2D context, reusable between frames. */
export interface AlphaHitScratch {
  canvas: CanvasImageSource;
  context: ScratchPaintContext;
}

export interface AlphaHitTarget {
  /** Size of the layer's box in source pixels — also the mask size. */
  sourceWidth: number;
  sourceHeight: number;
  /** Konva's unique hit colour for this shape; the hit canvas is read back by colour. */
  colorKey: string;
}

/**
 * Paint `image`'s opaque pixels into the hit canvas as `target.colorKey`.
 *
 * Without a scratch canvas (no DOM: SSR, unit tests) the whole rectangle is
 * registered instead — a picture that cannot be clicked at all is worse than one
 * whose transparent corners are clickable.
 */
export function paintAlphaHit(
  hit: HitPaintContext,
  target: AlphaHitTarget,
  image: CanvasImageSource,
  scratch: AlphaHitScratch | null,
): void {
  const { sourceWidth, sourceHeight, colorKey } = target;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return;

  if (!scratch) {
    hit.save();
    hit.setAttr('globalCompositeOperation', 'source-over');
    hit.setAttr('fillStyle', colorKey);
    hit.fillRect(0, 0, sourceWidth, sourceHeight);
    hit.restore();
    return;
  }

  const { context } = scratch;
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalCompositeOperation = 'source-over';
  context.clearRect(0, 0, sourceWidth, sourceHeight);
  context.drawImage(image, 0, 0, sourceWidth, sourceHeight);

  /*
    `source-in` is only safe on this isolated canvas: it keeps the fill colour
    where the image is opaque and clears the rest, which is exactly the mask we
    want. On the shared hit canvas the same operation would erase the layers
    underneath — see the module comment.
  */
  context.globalCompositeOperation = 'source-in';
  context.fillStyle = colorKey;
  context.fillRect(0, 0, sourceWidth, sourceHeight);
  context.globalCompositeOperation = 'source-over';

  hit.save();
  hit.setAttr('globalCompositeOperation', 'source-over');
  hit.drawImage(scratch.canvas, 0, 0);
  hit.restore();
}

/**
 * Lazily created, resized-on-demand scratch canvas for {@link paintAlphaHit}.
 *
 * One canvas is shared by every layer: hit painting happens synchronously inside
 * a single draw pass, so there is no re-entrancy to worry about.
 */
export function createAlphaHitScratch(): (width: number, height: number) => AlphaHitScratch | null {
  let element: HTMLCanvasElement | null = null;
  let context: ScratchPaintContext | null = null;

  return (width: number, height: number) => {
    if (typeof document === 'undefined') return null;
    if (!element) {
      element = document.createElement('canvas');
      context = element.getContext('2d');
      if (!context) return null;
    }
    if (element.width !== width || element.height !== height) {
      element.width = width;
      element.height = height;
    }
    return context ? { canvas: element, context } : null;
  };
}
