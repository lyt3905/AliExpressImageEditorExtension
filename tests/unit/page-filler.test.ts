import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  VENDORED_MAX_UPLOAD_BYTES,
  buildFileMeta,
  dataUrlByteLength,
  dataUrlMime,
  describeBridgeFailure,
  fillPageImage,
  pickFrame,
  scoreSignals,
  successWarnings,
  type FrameSignals,
} from '../../src/background/page-filler';
import { PAGE_FILL_MAX_BYTES } from '../../src/shared/constants';
import { ErrorCode } from '../../src/shared/errors';
import { PAGE_FILL_MESSAGE_TYPE } from '../../src/shared/messages';
import type { EditorSessionMeta, PageFillBridgeResult, PageFillInput, PageFillRequest } from '../../src/shared/types';

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR_VALIDATION = resolve(here, '../../public/vendor/aeiir/shared/validation.js');

/** A real 1x1 PNG — 70 bytes once decoded. */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

const PRODUCT_URL = 'https://seller.aliexpress.com/product/publish.htm';

function signals(overrides: Partial<FrameSignals> = {}): FrameSignals {
  return {
    frameUrl: PRODUCT_URL,
    isTopFrame: true,
    uploadButtonCount: 0,
    fileInputCount: 0,
    imageFileInputCount: 0,
    dropZoneCount: 0,
    hasUploadHint: false,
    uploadWrapCount: 0,
    slotCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------- data URL maths

describe('dataUrlByteLength', () => {
  it('counts the decoded bytes, not the base64 characters', () => {
    // 96 base64 chars, but 70 real bytes — the vendored validator compares the
    // declared size against the decoded length and refuses the upload on a
    // mismatch, so this has to be exact.
    expect(PNG_1X1.length).toBeGreaterThan(70);
    expect(dataUrlByteLength(PNG_1X1)).toBe(70);
  });

  it('subtracts the base64 padding', () => {
    expect(dataUrlByteLength('data:text/plain;base64,QUJD')).toBe(3); // "ABC"
    expect(dataUrlByteLength('data:text/plain;base64,QUJDRA==')).toBe(4); // "ABCD"
  });

  it('agrees with a real base64 decode at every payload length', () => {
    // The vendored `base64ByteLength` uses the same arithmetic, and a wrong
    // number here surfaces much later as FILE_SIZE_MISMATCH mid-upload.
    for (let length = 0; length < 64; length += 1) {
      const payload = Buffer.from('x'.repeat(length)).toString('base64');
      expect(dataUrlByteLength(`data:image/png;base64,${payload}`)).toBe(length);
    }
  });

  it('returns 0 for a payload with no comma instead of guessing', () => {
    expect(dataUrlByteLength('data:image/png;base64')).toBe(0);
    expect(dataUrlByteLength('')).toBe(0);
  });
});

describe('dataUrlMime', () => {
  it('reads the declared type, lower-cased', () => {
    expect(dataUrlMime(PNG_1X1)).toBe('image/png');
    expect(dataUrlMime('data:IMAGE/JPEG;base64,QUJD')).toBe('image/jpeg');
  });

  it('returns an empty string when there is no type to read', () => {
    expect(dataUrlMime('blob:http://localhost/abc')).toBe('');
  });
});

describe('buildFileMeta', () => {
  it('declares the type the data URL carries rather than assuming PNG', () => {
    const meta = buildFileMeta({ sessionId: 's', filename: 'a.jpg', dataUrl: 'data:image/jpeg;base64,QUJD' });
    expect(meta).toEqual({ name: 'a.jpg', type: 'image/jpeg', size: 3 });
  });

  it('falls back to image/png only when the data URL declares nothing', () => {
    const meta = buildFileMeta({ sessionId: 's', filename: 'a.png', dataUrl: 'data:;base64,QUJD' });
    expect(meta.type).toBe('image/png');
  });
});

describe('upload ceiling', () => {
  it('matches the limit the vendored uploader actually enforces', () => {
    // Read the vendored module rather than restating its number: if the sister
    // project ever raises MAX_FILE_BYTES, this fails instead of the user's
    // upload failing halfway through the flow.
    delete (globalThis as unknown as Record<string, unknown>).AEIIR;
    // eslint-disable-next-line no-eval
    (0, eval)(readFileSync(VENDOR_VALIDATION, 'utf-8'));
    const ns = (globalThis as unknown as { AEIIR: { validation: { MAX_FILE_BYTES: number } } }).AEIIR;

    expect(VENDORED_MAX_UPLOAD_BYTES).toBe(ns.validation.MAX_FILE_BYTES);
    expect(PAGE_FILL_MAX_BYTES).toBe(ns.validation.MAX_FILE_BYTES);
    expect(PAGE_FILL_MAX_BYTES).toBe(5 * 1024 * 1024);
  });
});

// ---------------------------------------------------------------- frame choice

describe('scoreSignals', () => {
  it('scores an empty frame at zero, so pickFrame can ignore it outright', () => {
    expect(scoreSignals(signals(), 'form')).toBe(0);
    expect(scoreSignals(signals(), 'panel')).toBe(0);
  });

  it('ranks the product form above a bare file input', () => {
    const form = signals({ uploadWrapCount: 1, slotCount: 6, uploadButtonCount: 1 });
    const strayInput = signals({ fileInputCount: 1, imageFileInputCount: 1 });

    expect(scoreSignals(form, 'form')).toBeGreaterThan(scoreSignals(strayInput, 'form'));
  });

  it('ranks the open upload panel above the form that triggered it', () => {
    const form = signals({ uploadWrapCount: 1, slotCount: 6, uploadButtonCount: 1 });
    const panel = signals({ dropZoneCount: 1, hasUploadHint: true, imageFileInputCount: 1 });

    expect(scoreSignals(panel, 'panel')).toBeGreaterThan(scoreSignals(form, 'panel'));
  });
});

describe('pickFrame', () => {
  it('returns null when no frame scored, rather than defaulting to the main frame', () => {
    expect(pickFrame([{ frameId: 0, signals: signals() }], 'form')).toBeNull();
    expect(pickFrame([], 'form')).toBeNull();
  });

  it('picks the highest score', () => {
    const frames = [
      { frameId: 7, signals: signals({ isTopFrame: false, imageFileInputCount: 1 }) },
      { frameId: 3, signals: signals({ uploadWrapCount: 1, slotCount: 6 }) },
    ];
    expect(pickFrame(frames, 'form')?.frameId).toBe(3);
  });

  it('breaks a tie towards the main frame, then the lowest frame id', () => {
    const top = signals({ isTopFrame: true, uploadWrapCount: 1 });
    const nested = signals({ isTopFrame: false, uploadWrapCount: 1 });

    // Same score: the main frame wins regardless of the order frames came back in.
    expect(pickFrame([{ frameId: 1, signals: nested }, { frameId: 9, signals: top }], 'form')?.frameId).toBe(9);
    expect(pickFrame([{ frameId: 9, signals: top }, { frameId: 1, signals: nested }], 'form')?.frameId).toBe(9);

    // Two sibling iframes: deterministic, lowest id.
    expect(pickFrame([{ frameId: 5, signals: nested }, { frameId: 2, signals: nested }], 'form')?.frameId).toBe(2);
  });

  it('looks for a different frame once the panel is what matters', () => {
    const frames = [
      { frameId: 0, signals: signals({ isTopFrame: true, uploadWrapCount: 1, slotCount: 6 }) },
      { frameId: 4, signals: signals({ isTopFrame: false, dropZoneCount: 1, hasUploadHint: true }) },
    ];
    expect(pickFrame(frames, 'form')?.frameId).toBe(0);
    expect(pickFrame(frames, 'panel')?.frameId).toBe(4);
  });
});

// ---------------------------------------------------------------- failure text

function bridgeResult(overrides: Partial<PageFillBridgeResult> = {}): PageFillBridgeResult {
  return {
    ok: false,
    status: 'failed',
    stage: 'INJECT_FILE',
    code: 'FILE_INJECTION_FAILED',
    message: '文件大小不一致',
    stages: [
      { stage: 'OPEN_PANEL', stageLabel: '打开上传面板', status: 'ok', message: '' },
      { stage: 'INJECT_FILE', stageLabel: '注入图片文件', status: 'failed', message: '文件大小不一致' },
    ],
    elapsedMs: 120,
    frameUrl: PRODUCT_URL,
    upload: null,
    confirmUpload: null,
    ...overrides,
  };
}

describe('describeBridgeFailure', () => {
  it('names the step that failed, using the bridge’s own stage labels', () => {
    expect(describeBridgeFailure(bridgeResult())).toContain('注入图片文件');
    expect(describeBridgeFailure(bridgeResult())).toContain('文件大小不一致');
  });

  it('explains the missing panel instead of leaking the raw code', () => {
    const message = describeBridgeFailure(
      bridgeResult({ code: 'UPLOAD_PANEL_NOT_FOUND', stage: 'FIND_DROP_ZONE', message: '本 frame 内没有出现上传面板' }),
    );

    expect(message).toContain('没有出现图片上传面板');
    expect(message).not.toContain('UPLOAD_PANEL_NOT_FOUND');
  });

  it('still answers when the bridge recorded no failed stage at all', () => {
    const message = describeBridgeFailure(bridgeResult({ stages: [], stage: null, message: '' }));
    expect(message).toBe('回填失败：未提供原因');
  });
});

// ---------------------------------------------------------------- success warnings

describe('successWarnings', () => {
  const degradedSlotNotice =
    '没有找到空槽位（可见上传按钮 5 个都挂在已占用的槽位上），已改用第 0 个按钮，可能会覆盖已有图片，请回商品页核对';

  const degradedStage = {
    stage: 'OPEN_PANEL',
    stageLabel: '打开上传面板',
    status: 'notice' as const,
    message: degradedSlotNotice,
  };

  it('surfaces the notice that warns an occupied slot may have been overwritten', () => {
    const result = successResult({
      stages: [
        degradedStage,
        { stage: 'INJECT_FILE', stageLabel: '注入图片文件', status: 'ok', message: '已注入文件' },
      ],
    });

    expect(successWarnings(result)).toEqual([degradedSlotNotice]);
  });

  it('reports nothing for a clean success', () => {
    expect(successWarnings(successResult())).toEqual([]);
  });

  it('stays quiet about a merely unconfirmed run, which already asks the user to check', () => {
    // The unconfirmed message itself says to verify by hand; repeating a notice
    // on top of it just buries the part that matters.
    const result = successResult({ status: 'unconfirmed', stages: [degradedStage] });
    expect(successWarnings(result)).toEqual([]);
  });

  it('ignores failed stages and empty messages', () => {
    const result = successResult({
      stages: [
        { stage: 'X', stageLabel: 'X', status: 'notice', message: '' },
        { stage: 'Y', stageLabel: 'Y', status: 'ok', message: '一切正常' },
        { stage: 'Z', stageLabel: 'Z', status: 'failed', message: '注入失败' },
      ],
    });

    expect(successWarnings(result)).toEqual([]);
  });
});

// ---------------------------------------------------------------- orchestration

interface ScriptCall {
  allFrames?: boolean;
  frameIds?: number[];
  files?: string[];
  hasFunc: boolean;
}

interface ChromePlan {
  frames?: Array<{ frameId: number; signals: FrameSignals }>;
  tabUrl?: string | null;
  /** Answer for the injected bridge, per attempt (1-based). */
  bridge?: (attempt: number, frameId: number, payload: PageFillRequest) => PageFillBridgeResult;
}

function installChrome(plan: ChromePlan): { scriptCalls: ScriptCall[]; bridgePayloads: PageFillRequest[] } {
  const scriptCalls: ScriptCall[] = [];
  const bridgePayloads: PageFillRequest[] = [];
  let attempts = 0;

  const chromeMock = {
    scripting: {
      executeScript: async (options: {
        target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
        func?: unknown;
        files?: string[];
      }) => {
        scriptCalls.push({
          allFrames: options.target.allFrames,
          frameIds: options.target.frameIds,
          files: options.files,
          hasFunc: typeof options.func === 'function',
        });
        if (typeof options.func === 'function') {
          return (plan.frames ?? []).map((frame) => ({ frameId: frame.frameId, result: frame.signals }));
        }
        return [{ frameId: options.target.frameIds?.[0] ?? 0 }];
      },
    },
    tabs: {
      get: async () => {
        if (plan.tabUrl === null) throw new Error('No tab with id');
        return { id: 42, url: plan.tabUrl ?? PRODUCT_URL };
      },
      update: async () => ({ id: 42 }),
      sendMessage: async (_tabId: number, message: { type: string; payload: PageFillRequest }) => {
        attempts += 1;
        bridgePayloads.push(message.payload);
        expect(message.type).toBe(PAGE_FILL_MESSAGE_TYPE);
        return (plan.bridge ?? (() => bridgeResult()))(attempts, 0, message.payload);
      },
    },
  };

  (globalThis as unknown as Record<string, unknown>).chrome = chromeMock;
  return { scriptCalls, bridgePayloads };
}

const SESSION: EditorSessionMeta = {
  id: 's1',
  createdAt: 1,
  sourceTabId: 42,
  sourceUrl: PRODUCT_URL,
  imageIds: [],
};

const FILL_INPUT: PageFillInput = {
  sessionId: 's1',
  dataUrl: PNG_1X1,
  filename: 'aliexpress-composite-20260927-120000.png',
};

function successResult(overrides: Partial<PageFillBridgeResult> = {}): PageFillBridgeResult {
  return {
    ok: true,
    status: 'success',
    stage: 'COMPLETE',
    code: null,
    message: '已把新图上传到商品页图片区并点击了「确认上传」',
    stages: [],
    elapsedMs: 900,
    frameUrl: PRODUCT_URL,
    upload: { status: 'UPLOAD_CONFIRMED', confirmed: true, strategy: 'input', criteria: 'preview-count-increased' },
    confirmUpload: { skipped: false, clicked: true, found: true, panelClosed: true, buttonText: '确认上传' },
    ...overrides,
  };
}

const panelMissing = (): PageFillBridgeResult =>
  bridgeResult({ code: 'UPLOAD_PANEL_NOT_FOUND', stage: 'FIND_DROP_ZONE', message: '本 frame 内没有出现上传面板' });

describe('fillPageImage', () => {
  beforeEach(() => {
    delete (globalThis as unknown as Record<string, unknown>).chrome;
  });

  it('injects the whole vendor chain into the product-form frame and reports where it ran', async () => {
    const { scriptCalls } = installChrome({
      frames: [{ frameId: 0, signals: signals({ uploadWrapCount: 1, slotCount: 6, uploadButtonCount: 1 }) }],
      bridge: () => successResult(),
    });

    const result = await fillPageImage(FILL_INPUT, SESSION);

    const injection = scriptCalls.find((call) => call.files);
    expect(injection?.frameIds).toEqual([0]);
    // Load order is load-bearing: each file reads its siblings at load time.
    expect(injection?.files).toEqual([
      'vendor/aeiir/shared/messages.js',
      'vendor/aeiir/shared/errors.js',
      'vendor/aeiir/shared/validation.js',
      'vendor/aeiir/content/dom-wait.js',
      'vendor/aeiir/content/upload-locator.js',
      'vendor/aeiir/content/file-injector.js',
      'vendor/aeiir/bridge.js',
    ]);

    expect(result.status).toBe('success');
    expect(result.frameId).toBe(0);
    expect(result.strategy).toBe('input');
    expect(result.confirmed).toBe(true);
  });

  it('probes every frame with a self-contained function, so each result carries its own frameId', async () => {
    const { scriptCalls } = installChrome({
      frames: [{ frameId: 0, signals: signals({ uploadWrapCount: 1, slotCount: 6 }) }],
      bridge: () => successResult(),
    });

    await fillPageImage(FILL_INPUT, SESSION);

    const probe = scriptCalls.find((call) => call.hasFunc);
    expect(probe?.allFrames).toBe(true);
  });

  it('sends the declared byte length, which is what the uploader cross-checks', async () => {
    const { bridgePayloads } = installChrome({
      frames: [{ frameId: 2, signals: signals({ uploadWrapCount: 1, slotCount: 6 }) }],
      bridge: () => successResult(),
    });

    await fillPageImage(FILL_INPUT, SESSION);

    expect(bridgePayloads[0]?.fileMeta).toEqual({
      name: 'aliexpress-composite-20260927-120000.png',
      type: 'image/png',
      size: 70,
    });
    expect(bridgePayloads[0]?.confirmUploadClick).toBe(true);
  });

  it('carries a degraded-slot warning through to the editor instead of hiding it behind success', async () => {
    installChrome({
      frames: [{ frameId: 0, signals: signals({ uploadWrapCount: 1, slotCount: 6 }) }],
      bridge: () =>
        successResult({
          stages: [
            {
              stage: 'OPEN_PANEL',
              stageLabel: '打开上传面板',
              status: 'notice',
              message: '没有找到空槽位，可能会覆盖已有图片，请回商品页核对',
            },
          ],
        }),
    });

    const result = await fillPageImage(FILL_INPUT, SESSION);

    expect(result.status).toBe('success');
    expect(result.warnings).toEqual(['没有找到空槽位，可能会覆盖已有图片，请回商品页核对']);
  });

  it('retries in another frame with openPanel off, so the already-open panel is not toggled shut', async () => {
    const { bridgePayloads } = installChrome({
      frames: [
        { frameId: 0, signals: signals({ uploadWrapCount: 1, slotCount: 6 }) },
        { frameId: 6, signals: signals({ isTopFrame: false, dropZoneCount: 1, hasUploadHint: true }) },
      ],
      bridge: (attempt) => (attempt === 1 ? panelMissing() : successResult()),
    });

    const result = await fillPageImage(FILL_INPUT, SESSION);

    expect(bridgePayloads.map((payload) => payload.openPanel)).toEqual([true, false]);
    expect(result.status).toBe('success');
    expect(result.frameId).toBe(6);
  });

  it('asks for the first image to be deleted on the first attempt only', async () => {
    // Deleting is destructive and irreversible by this flow, so a retry must NOT
    // carry the flag: attempt 1 already removed the first image, and asking again
    // would take out the SECOND one.
    const { bridgePayloads } = installChrome({
      frames: [
        { frameId: 0, signals: signals({ uploadWrapCount: 1, slotCount: 6 }) },
        { frameId: 6, signals: signals({ isTopFrame: false, dropZoneCount: 1, hasUploadHint: true }) },
      ],
      bridge: (attempt) => (attempt === 1 ? panelMissing() : successResult()),
    });

    await fillPageImage({ ...FILL_INPUT, removeFirstImage: true }, SESSION);

    expect(bridgePayloads.map((payload) => payload.removeFirstImage)).toEqual([true, false]);
  });

  it('never carries the delete flag when the editor did not ask for it', async () => {
    const { bridgePayloads } = installChrome({
      frames: [{ frameId: 0, signals: signals({ uploadWrapCount: 1, slotCount: 6 }) }],
      bridge: () => successResult(),
    });

    await fillPageImage(FILL_INPUT, SESSION);

    expect(bridgePayloads.map((payload) => payload.removeFirstImage)).toEqual([false]);
  });

  it('gives the delete step its own budget instead of the upload allowance', async () => {
    const { bridgePayloads } = installChrome({
      frames: [{ frameId: 0, signals: signals({ uploadWrapCount: 1, slotCount: 6 }) }],
      bridge: () => successResult(),
    });

    await fillPageImage({ ...FILL_INPUT, removeFirstImage: true }, SESSION);

    const payload = bridgePayloads[0];
    expect(payload.deleteTimeout).toBe(8000);
    // The destructive step gets its own short budget instead of inheriting the
    // 25s upload allowance — hanging on a delete must not stall the whole fill.
    expect(payload.deleteTimeout).toBeLessThan(payload.uploadTimeout);
  });

  it('gives up after three frames instead of clicking in a loop', async () => {
    // The frame keeps looking like a plausible panel host, so every attempt runs.
    const { bridgePayloads, scriptCalls } = installChrome({
      frames: [{ frameId: 0, signals: signals({ uploadWrapCount: 1, slotCount: 6, dropZoneCount: 1 }) }],
      bridge: () => panelMissing(),
    });

    await expect(fillPageImage(FILL_INPUT, SESSION)).rejects.toMatchObject({
      code: ErrorCode.PAGE_FILL_FAILED,
    });
    expect(bridgePayloads).toHaveLength(3);
    expect(bridgePayloads.map((payload) => payload.openPanel)).toEqual([true, false, false]);
    // One injection per frame, not per attempt: the idempotency guard would
    // otherwise be doing work the orchestrator should already avoid.
    expect(scriptCalls.filter((call) => call.files)).toHaveLength(1);
  }, 20_000);

  it('stops retrying when no frame looks like it holds the panel', async () => {
    // Retrying a frame that scores zero for the panel phase just costs the user
    // another 900ms; the failure from attempt 1 is already the right answer.
    const { bridgePayloads } = installChrome({
      frames: [{ frameId: 0, signals: signals({ uploadWrapCount: 1, slotCount: 6 }) }],
      bridge: () => panelMissing(),
    });

    await expect(fillPageImage(FILL_INPUT, SESSION)).rejects.toMatchObject({
      code: ErrorCode.PAGE_FILL_FAILED,
    });
    expect(bridgePayloads).toHaveLength(1);
  });

  it('refuses a PNG over the uploader’s ceiling before touching the page', async () => {
    const { scriptCalls } = installChrome({ frames: [] });
    const oversized: PageFillInput = {
      ...FILL_INPUT,
      // Declared as huge so the size check trips without allocating 5 MB.
      dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil((PAGE_FILL_MAX_BYTES + 1) / 3) * 4)}`,
    };

    await expect(fillPageImage(oversized, SESSION)).rejects.toMatchObject({
      code: ErrorCode.PAGE_FILL_FAILED,
    });
    expect(scriptCalls).toHaveLength(0);
  });

  it('says so when the original product tab is gone', async () => {
    installChrome({ tabUrl: null });

    await expect(fillPageImage(FILL_INPUT, SESSION)).rejects.toMatchObject({
      code: ErrorCode.NO_ACTIVE_TAB,
    });
  });

  it('refuses to fill when the tab is no longer an AliExpress product page', async () => {
    installChrome({ tabUrl: 'https://www.example.com/cart' });

    await expect(fillPageImage(FILL_INPUT, SESSION)).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_PAGE,
    });
  });

  it('reports “no image area found” rather than silently doing nothing', async () => {
    installChrome({ frames: [{ frameId: 0, signals: signals() }] });

    await expect(fillPageImage(FILL_INPUT, SESSION)).rejects.toMatchObject({
      code: ErrorCode.UNSUPPORTED_PAGE,
    });
  });
});
