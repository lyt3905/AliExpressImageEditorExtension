/**
 * Export helpers for the 800x800 canvas.
 *
 * ## Why the size is not simply "pixelRatio = 1 / previewScale"
 *
 * Konva assigns the backing store with `canvas.width = width * pixelRatio` and does
 * **no rounding**; the HTML canvas element then truncates the fraction. So the
 * product has to land exactly on 800, not 799.9999.
 *
 * The original formula was `pixelRatio = 1 / previewScale`, where
 * `previewScale = stageWidth / 800` was computed earlier and then inverted. That
 * double rounding drops one ulp for **35 of the 201** even preview sizes in the
 * 240–640 range: `254 * (1 / (254 / 800))` is `799.9999999999999`, and the canvas
 * silently comes out 799x799. Deriving the ratio straight from the stage width
 * (`800 / stageWidth`) brings that down to 8 sizes, and the remaining ones are
 * absorbed by `normaliseToCanvasSize` below.
 *
 * This is why the failure looked intermittent and window-dependent: the preview size
 * follows the window, and the failing set is scattered through it. It also means
 * "export" and "fill back to the page" shared the bug — both go through here.
 *
 * The exported PNG is always a white background and always exactly 800x800.
 */

import type Konva from 'konva';
import { CANVAS_SIZE, EXPORT_MIME } from '../shared/constants';
import { AppError, ErrorCode, messageOf } from '../shared/errors';

export interface ExportHooks {
  /** Called after the UI was prepared (transformer hidden, white bg on). */
  before?: () => void;
  /** Always called, including on failure, so the UI can be restored. */
  after?: () => void;
}

export interface ExportOptions {
  /** Stage pixel size. Defaults to the live stage's own size. */
  width?: number;
  height?: number;
  /** Override the derived ratio (tests only). */
  pixelRatio?: number;
  hooks?: ExportHooks;
}

/**
 * How far off the produced canvas may be before this is treated as a real bug.
 *
 * One pixel is float truncation; more than that means the stage and the ratio
 * disagree (wrong width passed, or a stage that was never laid out), and quietly
 * rescaling that would export a wrong composition instead of failing loudly.
 */
const SIZE_TOLERANCE_PX = 1;

/** `aliexpress-composite-20260927-114500.png` */
export function buildExportFileName(date: Date = new Date()): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `aliexpress-composite-${stamp}.png`;
}

/**
 * Guarantee an exactly `expected` x `expected` canvas.
 *
 * Does nothing when the render already landed on the target size — the common case,
 * and a 1:1 path with no resampling. An off-by-one gets redrawn into a fresh canvas:
 * the source content was rendered at the right resolution, the canvas simply lost a
 * pixel to truncation, so stretching 799 -> 800 restores the intended geometry
 * instead of shipping a 799px "main image" that the page fill then rejects.
 */
export function normaliseToCanvasSize(
  rendered: HTMLCanvasElement,
  expected: number = CANVAS_SIZE,
): HTMLCanvasElement {
  if (rendered.width === expected && rendered.height === expected) return rendered;

  const offBy = Math.max(Math.abs(rendered.width - expected), Math.abs(rendered.height - expected));
  if (offBy > SIZE_TOLERANCE_PX) {
    throw new AppError(
      ErrorCode.UNKNOWN,
      `导出尺寸异常：${rendered.width}x${rendered.height}（期望 ${expected}x${expected}）`,
    );
  }

  const canvas = document.createElement('canvas');
  canvas.width = expected;
  canvas.height = expected;
  const context = canvas.getContext('2d');
  if (!context) throw new AppError(ErrorCode.UNKNOWN, '无法创建导出画布');
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(rendered, 0, 0, expected, expected);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), EXPORT_MIME, 1);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Render the composition into an 800x800 white-background PNG.
 *
 * Always exports white background, always normalised to exactly 800x800.
 */
export async function exportStageToPng(stage: Konva.Stage, options: ExportOptions = {}): Promise<Blob> {
  const width = options.width ?? stage.width();
  const height = options.height ?? stage.height();
  // One division, not a scale that gets inverted again: see the file header.
  const pixelRatio = options.pixelRatio ?? (width > 0 ? CANVAS_SIZE / width : 1);

  const hooks = options.hooks ?? {};
  hooks.before?.();
  try {
    const rendered = stage.toCanvas({ x: 0, y: 0, width, height, pixelRatio });
    const canvas = normaliseToCanvasSize(rendered, CANVAS_SIZE);

    const blob = await canvasToBlob(canvas);
    if (!blob || blob.size === 0) throw new AppError(ErrorCode.UNKNOWN, '导出结果为空');
    return blob;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(ErrorCode.UNKNOWN, `导出 PNG 失败：${messageOf(error)}`);
  } finally {
    hooks.after?.();
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new AppError(ErrorCode.UNKNOWN, '读取导出数据失败'));
    reader.readAsDataURL(blob);
  });
}
