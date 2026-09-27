/**
 * Page fill: put the exported 800x800 PNG back into the AliExpress product form.
 *
 * Everything that touches the product page happens through the sister
 * extension's library, vendored verbatim under `public/vendor/aeiir/` and
 * injected per frame with `chrome.scripting.executeScript`. This module is the
 * orchestration around it:
 *
 *   probe every frame -> pick the frame holding the product form -> inject
 *   -> drive the flow -> (if the upload panel lives in another frame) retry there
 *
 * Two deliberate constraints:
 *   - The composed PNG is only ever ADDED as a new slot image. `removeFirstImage`
 *     can delete the product's current first image beforehand, but only to free a
 *     slot: AliExpress shifts every later image forward, so the new image lands in
 *     the last slot either way. No slot is ever swapped in place.
 *   - The only buttons ever clicked inside the flow are the upload panel's own
 *     「确认上传」 and — when explicitly asked for — the first image's delete icon.
 *     The product-level save / publish is never touched, so the seller keeps the
 *     last word on the product.
 */

import { PAGE_FILL_MAX_BYTES } from '../shared/constants';
import { ErrorCode, AppError, messageOf } from '../shared/errors';
import { PAGE_FILL_MESSAGE_TYPE, createRequestId, sendToFrame, type PageFillMessage } from '../shared/messages';
import { evaluatePageGate } from '../shared/page-gate';
import type {
  EditorSessionMeta,
  PageFillBridgeResult,
  PageFillInput,
  PageFillRequest,
  PageFillResult,
} from '../shared/types';

/**
 * The vendored library, in load order.
 *
 * These are CLASSIC scripts that hang themselves off `globalThis.AEIIR` and are
 * injected as a `files` list rather than imported, because `executeScript`
 * `files` is the only way to load a classic script into a non-top frame. Order
 * is load-bearing: each file reads its siblings at load time.
 *
 * `bridge.js` is ours, not the sister project's — it is the frame-side driver.
 */
const BRIDGE_FILES: readonly string[] = [
  'vendor/aeiir/shared/messages.js',
  'vendor/aeiir/shared/errors.js',
  'vendor/aeiir/shared/validation.js',
  'vendor/aeiir/content/dom-wait.js',
  'vendor/aeiir/content/upload-locator.js',
  'vendor/aeiir/content/file-injector.js',
  'vendor/aeiir/bridge.js',
];

/**
 * Upload ceiling inside the vendored `validation.js` (`MAX_FILE_BYTES`).
 *
 * `page-filler.test.ts` pins this to the vendored source, so the copy in
 * `constants.ts` cannot drift away from what the uploader actually enforces.
 */
export const VENDORED_MAX_UPLOAD_BYTES = PAGE_FILL_MAX_BYTES;

const PANEL_TIMEOUT_MS = 8000;
const UPLOAD_TIMEOUT_MS = 25000;
const CONFIRM_TIMEOUT_MS = 8000;
/** Waiting for the delete icon, and then for the image to actually disappear. */
const DELETE_TIMEOUT_MS = 8000;
/** Attempt 1 targets the product form; 2..N look for the panel itself. */
const MAX_FRAME_ATTEMPTS = 3;
const FRAME_RETRY_DELAY_MS = 900;

/** Returned by the bridge when the panel is not in the frame it ran in. */
const PANEL_MISSING_CODE = 'UPLOAD_PANEL_NOT_FOUND';

// ---------------------------------------------------------------- data URL maths

/**
 * Decoded byte length of a base64 data URL.
 *
 * Measured here rather than trusted from the editor: the vendored validator
 * compares the declared size against the decoded bytes and refuses to upload on
 * a mismatch, so a wrong number would surface as a confusing error mid-flow.
 */
export function dataUrlByteLength(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma === -1) return 0;
  const payload = dataUrl.slice(comma + 1);
  let padding = 0;
  if (payload.endsWith('==')) padding = 2;
  else if (payload.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** MIME type declared in the data URL header, lower-cased. Empty when absent. */
export function dataUrlMime(dataUrl: string): string {
  const match = /^data:([^;,]+)/i.exec(dataUrl);
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * File metadata for the vendored validator.
 *
 * The declared type is read from the data URL itself, never assumed: the
 * validator cross-checks it against the decoded PNG/JPEG magic and reports a
 * mismatch instead of uploading something other than what the user composed.
 */
export function buildFileMeta(input: PageFillInput): PageFillRequest['fileMeta'] {
  return {
    name: input.filename,
    type: dataUrlMime(input.dataUrl) || 'image/png',
    size: dataUrlByteLength(input.dataUrl),
  };
}

// ---------------------------------------------------------------- frame probing

/** Read-only signals about one frame's document. */
export interface FrameSignals {
  frameUrl: string;
  isTopFrame: boolean;
  uploadButtonCount: number;
  fileInputCount: number;
  imageFileInputCount: number;
  dropZoneCount: number;
  hasUploadHint: boolean;
  uploadWrapCount: number;
  slotCount: number;
}

/** Which signal set to weigh: the product form, or the upload panel itself. */
export type ProbePhase = 'form' | 'panel';

/**
 * Runs in EVERY frame via `executeScript({ allFrames: true })`, which is also
 * what gives us each result's `frameId` — no `webNavigation` permission and no
 * `all_frames: true` in the manifest are needed.
 *
 * MUST stay self-contained: `executeScript` serialises this function into the
 * page, so it cannot close over anything from this module.
 */
export function probeFrameSignals(): FrameSignals {
  const doc = document;
  const count = (selector: string): number => {
    try {
      return doc.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  };

  let fileInputs: Element[] = [];
  try {
    fileInputs = Array.from(doc.querySelectorAll('input[type="file"]'));
  } catch {
    fileInputs = [];
  }
  const imageFileInputs = fileInputs.filter((element) => {
    const accept = element.getAttribute('accept') ?? '';
    return !accept || /image/i.test(accept);
  });

  let hasUploadHint = false;
  try {
    hasUploadHint = (doc.body?.textContent ?? '').includes('点击此处或者将文件拖至此处');
  } catch {
    hasUploadHint = false;
  }

  let isTopFrame = false;
  try {
    isTopFrame = window.top === window;
  } catch {
    isTopFrame = false;
  }

  return {
    frameUrl: location.href,
    isTopFrame,
    uploadButtonCount: count('div.image-upload-btn'),
    fileInputCount: fileInputs.length,
    imageFileInputCount: imageFileInputs.length,
    dropZoneCount: count('div.material-center-upload-drag'),
    hasUploadHint,
    uploadWrapCount: count('.imageUploadWrap'),
    slotCount: count('.sell-o-image-item'),
  };
}

/**
 * Score one frame's signals for the given phase.
 *
 * Zero means "nothing here". The weights mirror the order the flow relies on:
 * a drag zone outranks everything once the panel is open, while before that the
 * `.imageUploadWrap` widget is the clearest sign of the product form.
 */
export function scoreSignals(signals: FrameSignals, phase: ProbePhase): number {
  if (phase === 'panel') {
    return (
      (signals.dropZoneCount > 0 ? 6 : 0) +
      (signals.hasUploadHint ? 3 : 0) +
      (signals.imageFileInputCount > 0 ? 2 : 0) +
      (signals.uploadButtonCount > 0 ? 1 : 0)
    );
  }
  return (
    (signals.uploadWrapCount > 0 ? 4 : 0) +
    (signals.slotCount > 0 ? 3 : 0) +
    (signals.uploadButtonCount > 0 ? 3 : 0) +
    (signals.hasUploadHint ? 2 : 0) +
    (signals.imageFileInputCount > 0 ? 1 : 0)
  );
}

export interface ProbedFrame {
  frameId: number;
  signals: FrameSignals;
}

/**
 * Best-scoring frame for a phase, or null when nothing scored.
 *
 * Ties break towards the main frame and then the lowest frame id, so the choice
 * never depends on the order `executeScript` happens to return frames in.
 */
export function pickFrame(frames: readonly ProbedFrame[], phase: ProbePhase): ProbedFrame | null {
  const scored = frames
    .map((frame) => ({ frame, score: scoreSignals(frame.signals, phase) }))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(right.frame.signals.isTopFrame) - Number(left.frame.signals.isTopFrame) ||
        left.frame.frameId - right.frame.frameId,
    );
  return scored[0]?.frame ?? null;
}

async function probeFrames(tabId: number): Promise<ProbedFrame[]> {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: probeFrameSignals,
  });
  const frames: ProbedFrame[] = [];
  for (const entry of results) {
    // A frame we have no host permission for simply produces no entry; one whose
    // script threw produces an entry with an undefined result.
    if (entry.frameId === undefined || !entry.result) continue;
    frames.push({ frameId: entry.frameId, signals: entry.result });
  }
  return frames;
}

// ---------------------------------------------------------------- injection

async function injectBridge(tabId: number, frameId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: [...BRIDGE_FILES],
    });
  } catch (error) {
    throw new AppError(ErrorCode.PAGE_FILL_FAILED, `注入回填脚本失败：${messageOf(error)}`);
  }
}

async function runBridge(
  tabId: number,
  frameId: number,
  payload: PageFillRequest,
): Promise<PageFillBridgeResult> {
  const message: PageFillMessage = {
    type: PAGE_FILL_MESSAGE_TYPE,
    requestId: createRequestId('fill'),
    payload,
  };
  try {
    return await sendToFrame(tabId, frameId, message);
  } catch (error) {
    throw new AppError(
      ErrorCode.PAGE_FILL_FAILED,
      `回填脚本无响应（frame ${frameId}）：${messageOf(error)}`,
    );
  }
}

// ---------------------------------------------------------------- result mapping

/**
 * Turn a bridge failure into one line that names the step and the reason.
 *
 * The bridge records every stage, so the label comes from its own table rather
 * than a second copy here.
 */
export function describeBridgeFailure(result: PageFillBridgeResult): string {
  if (result.code === PANEL_MISSING_CODE) {
    return '点击上传按钮后页面上没有出现图片上传面板，请回商品页确认能手动上传（页面结构可能已变化）';
  }
  const failed = [...(result.stages ?? [])].reverse().find((record) => record.status === 'failed');
  const label = failed?.stageLabel ?? result.stage ?? '回填';
  return `${label}失败：${result.message || '未提供原因'}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Warnings the bridge recorded while still reporting success.
 *
 * Only consulted for a CONFIRMED success, which is precisely the case where the
 * success message would otherwise be the whole story — for example「已点击
 * 『确认上传』，但上传面板仍未关闭」：the click happened, yet whether the image
 * really landed on the product page is up to the seller to verify. A run that
 * is merely "unconfirmed" already tells the user to go and check the page.
 */
export function successWarnings(result: PageFillBridgeResult): string[] {
  if (result.status !== 'success') return [];
  return (result.stages ?? [])
    .filter((record) => record.status === 'notice' && record.message)
    .map((record) => record.message);
}

// ---------------------------------------------------------------- entry point

/**
 * Drive the whole page-fill flow for one exported PNG.
 *
 * @param input the composed PNG plus the session it belongs to
 * @param meta the session record — the only place the source tab is remembered
 */
export async function fillPageImage(input: PageFillInput, meta: EditorSessionMeta): Promise<PageFillResult> {
  const tabId = meta.sourceTabId;

  const byteLength = dataUrlByteLength(input.dataUrl);
  if (byteLength <= 0) {
    throw new AppError(ErrorCode.PAGE_FILL_FAILED, '待回填的 PNG 数据为空');
  }
  if (byteLength > VENDORED_MAX_UPLOAD_BYTES) {
    throw new AppError(
      ErrorCode.PAGE_FILL_FAILED,
      `PNG 体积 ${(byteLength / 1024 / 1024).toFixed(2)} MB，超过速卖通图片上传上限 5 MB，请减少图层或缩小素材后重试`,
    );
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) {
    throw new AppError(ErrorCode.NO_ACTIVE_TAB, '原来的商品页标签已经关闭，请重新扫描商品页后再回填');
  }
  const gate = evaluatePageGate(tab.url);
  if (!gate.ok) {
    throw new AppError(ErrorCode.UNSUPPORTED_PAGE, '原标签已不是 AliExpress 商品页，请切换回商品页后重试');
  }

  // Bring the product page forward: a hidden tab gets its timers throttled, and
  // the page visibly changing is the best confirmation the user can get.
  await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);

  const fileMeta = buildFileMeta(input);
  const injectedFrames = new Set<number>();
  let last: { frame: ProbedFrame; result: PageFillBridgeResult } | null = null;

  for (let attempt = 1; attempt <= MAX_FRAME_ATTEMPTS; attempt += 1) {
    const phase: ProbePhase = attempt === 1 ? 'form' : 'panel';
    const frame = pickFrame(await probeFrames(tabId), phase);
    if (!frame) break;

    // Inject on every hop: the frame that ends up owning the panel may never
    // have been touched before, and `frameIds` only ever covers one frame.
    if (!injectedFrames.has(frame.frameId)) {
      await injectBridge(tabId, frame.frameId);
      injectedFrames.add(frame.frameId);
    }

    const result = await runBridge(tabId, frame.frameId, {
      dataUrl: input.dataUrl,
      fileMeta,
      // Only the first attempt may click the upload button: on a retry the
      // panel is already open, and clicking again would close it.
      openPanel: attempt === 1,
      // Same reasoning, with more at stake: the first attempt already deleted the
      // first image, so a retry that deleted again would take out the SECOND one.
      removeFirstImage: attempt === 1 && input.removeFirstImage === true,
      confirmUploadClick: true,
      panelTimeout: PANEL_TIMEOUT_MS,
      uploadTimeout: UPLOAD_TIMEOUT_MS,
      confirmTimeout: CONFIRM_TIMEOUT_MS,
      deleteTimeout: DELETE_TIMEOUT_MS,
    });
    last = { frame, result };

    if (result.code !== PANEL_MISSING_CODE) break;
    if (attempt < MAX_FRAME_ATTEMPTS) await delay(FRAME_RETRY_DELAY_MS);
  }

  if (!last) {
    throw new AppError(
      ErrorCode.UNSUPPORTED_PAGE,
      '页面上没有找到 AliExpress 的图片上传区，请确认商品编辑页已打开且处于可编辑状态',
    );
  }

  const result = last.result;
  console.log('[AIEE] page fill', result.status, result.code ?? '', result.stages ?? []);

  if (!result.ok || result.status === 'failed') {
    throw new AppError(ErrorCode.PAGE_FILL_FAILED, describeBridgeFailure(result));
  }

  return {
    status: result.status,
    stage: result.stage,
    code: result.code,
    message: result.message,
    stages: result.stages ?? [],
    warnings: successWarnings(result),
    elapsedMs: result.elapsedMs ?? 0,
    frameId: last.frame.frameId,
    frameUrl: last.frame.signals.frameUrl,
    strategy: result.upload ? (result.upload.strategy as 'input' | 'drop-zone') : null,
    confirmed: Boolean(result.upload?.confirmed),
  };
}
