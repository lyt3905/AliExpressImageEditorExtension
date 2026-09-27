/**
 * Content script entry point.
 *
 * Deliberately tiny: it only answers SCAN_ACTIVE_TAB. All orchestration lives
 * in the service worker.
 */

import { AliExpressPageAdapter } from './aliexpress-page-adapter';
import { ErrorCode, messageOf, toAppError } from '../shared/errors';
import { errorResponse, isExtensionMessage, okResponse, type MessageResponse } from '../shared/messages';
import type { ScannedImage } from '../shared/types';

declare global {
  interface Window {
    __AIEE_CONTENT_SCRIPT__?: boolean;
  }
}

const FLAG = '__AIEE_CONTENT_SCRIPT__';

function handleScan(requestId: string): MessageResponse<{ images: ScannedImage[]; strategy: string }> {
  try {
    const adapter = new AliExpressPageAdapter(document);
    const { images, strategy } = adapter.scanMainImagesWithStrategy();

    if (!adapter.isSupportedPage() && images.length === 0) {
      return errorResponse(requestId, ErrorCode.UNSUPPORTED_PAGE, '当前页面不是受支持的 AliExpress 商品编辑页');
    }
    if (images.length === 0) {
      return errorResponse(
        requestId,
        ErrorCode.NO_IMAGES,
        `未在页面中找到商品主图（页面 img 总数：${adapter.countImages()}）`,
      );
    }
    return okResponse(requestId, { images, strategy });
  } catch (error) {
    const appError = toAppError(error, '商品主图扫描失败');
    return errorResponse(requestId, appError.code, appError.message);
  }
}

function install(): void {
  if (window[FLAG]) return;
  window[FLAG] = true;

  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response: MessageResponse<unknown>) => void) => {
      if (!isExtensionMessage(message)) return false;
      if (message.type === 'PING') {
        sendResponse(okResponse(message.requestId, 'pong'));
        return false;
      }
      if (message.type !== 'SCAN_ACTIVE_TAB') return false;

      try {
        sendResponse(handleScan(message.requestId));
      } catch (error) {
        sendResponse(errorResponse(message.requestId, ErrorCode.UNKNOWN, messageOf(error)));
      }
      return false;
    },
  );
}

install();
