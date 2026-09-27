/**
 * Reserved interface for writing the composed PNG back into the AliExpress
 * product form. v1 must never modify the page — this class is intentionally a
 * no-op so the seam exists without any side effects.
 */

import { AppError, ErrorCode } from '../shared/errors';
import type { PageImageWriter } from '../shared/types';

export class DisabledPageImageWriter implements PageImageWriter {
  async replaceMainImage(): Promise<void> {
    throw new AppError(ErrorCode.NOT_IMPLEMENTED, '当前版本暂不支持商品图片回填');
  }
}

export const pageImageWriter: PageImageWriter = new DisabledPageImageWriter();
