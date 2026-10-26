/**
 * Thumbnail a blob for the vision model.
 *
 * Two deliberate choices:
 *
 * - **White backdrop.** Cut-outs are transparent, and how a model interprets an
 *   alpha channel varies by runtime. White is also what the material will look like
 *   on the finished 主图, so the model judges the same picture the seller will see.
 * - **512px longest side.** Measured cost on the live gateway: ~550 prompt tokens
 *   per 512px image. Six full-size photos would cost roughly six times that for no
 *   better answer — role binding is about silhouette, not detail.
 */

import { VISION_THUMBNAIL_SIZE } from '../shared/constants';
import { blobToDataUrl } from './exporter';

export async function blobToThumbnailDataUrl(
  blob: Blob,
  maxSide = VISION_THUMBNAIL_SIZE,
): Promise<string> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建 2D 上下文，无法生成缩略图');

    context.fillStyle = '#FFFFFF';
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);

    const thumbnail = await canvas.convertToBlob({ type: 'image/png' });
    return await blobToDataUrl(thumbnail);
  } finally {
    bitmap.close();
  }
}
