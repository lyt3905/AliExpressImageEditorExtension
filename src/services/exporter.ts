/**
 * Export helpers for the 800x800 canvas.
 *
 * The Konva Stage is rendered at a preview size (`stageWidth = 800 * previewScale`)
 * and a root layer carries `previewScale`, so the export compensates with
 * `pixelRatio = 1 / previewScale`. The result is verified to be exactly 800x800.
 *
 * A dedicated white background layer is switched on for the export, whatever the
 * user happens to be previewing.
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
  /** Visual scale currently applied to the stage content. */
  previewScale?: number;
  width?: number;
  height?: number;
  pixelRatio?: number;
  hooks?: ExportHooks;
}

/** `aliexpress-composite-20260927-114500.png` */
export function buildExportFileName(date: Date = new Date()): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const stamp =
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `aliexpress-composite-${stamp}.png`;
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
 * Always exports white background, always pixelRatio-normalised to 1:1.
 */
export async function exportStageToPng(stage: Konva.Stage, options: ExportOptions = {}): Promise<Blob> {
  const width = options.width ?? stage.width();
  const height = options.height ?? stage.height();
  const previewScale = options.previewScale && options.previewScale > 0 ? options.previewScale : 1;
  const pixelRatio = options.pixelRatio ?? 1 / previewScale;

  const hooks = options.hooks ?? {};
  hooks.before?.();
  try {
    const canvas = stage.toCanvas({ x: 0, y: 0, width, height, pixelRatio });
    if (canvas.width !== CANVAS_SIZE || canvas.height !== CANVAS_SIZE) {
      throw new AppError(ErrorCode.UNKNOWN, `导出尺寸异常：${canvas.width}x${canvas.height}（期望 800x800）`);
    }
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
