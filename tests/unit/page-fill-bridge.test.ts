// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://seller.aliexpress.com/product/publish.htm"}
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The injected bridge driven against the captured product-page fixture.
 *
 * `public/vendor/aeiir/*.js` are CLASSIC scripts loaded in manifest order, so
 * they are read and evaluated the same way `chrome.scripting.executeScript`
 * `files` loads them — importing them as modules would exercise a different
 * code path than production.
 */

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR_ROOT = resolve(here, '../../public/vendor/aeiir');
const FIXTURE = readFileSync(resolve(here, '../fixtures/aliexpress-page.html'), 'utf-8');

const VENDOR_FILES = [
  'shared/messages.js',
  'shared/errors.js',
  'shared/validation.js',
  'content/dom-wait.js',
  'content/upload-locator.js',
  'content/file-injector.js',
  'bridge.js',
];

/** A 1x1 PNG — the vendored validator checks the real file magic, so it must be genuine. */
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/**
 * `validation.js` cross-checks `fileMeta.size` against the byte length it decodes
 * from the Data URL and refuses the injection on any difference, so the size has
 * to be derived rather than written down by hand.
 */
function byteLengthOfDataUrl(dataUrl: string): number {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

interface Bridge {
  chooseUploadButton: (survey: unknown) => {
    item: { text: string; index?: number; element: Element };
    emptyCount: number;
    filledCount: number;
    skippedEntries: { text: string; reason: string }[];
    buttonTexts: string[];
  } | null;
  skippedEntriesOf: (survey: unknown) => { text: string; reason: string }[];
  isFilledSlot: (slot: Element | null) => boolean;
  slotOf: (button: Element | null) => Element | null;
  surveySlots: (doc: Document) => { total: number; filled: number };
  slotsOf: (doc: Document) => Element[];
  findRemoveIcon: (slot: Element | null) => Element | null;
  removeFirstImage: (
    doc: Document,
    win: Window,
    options: { recorder: unknown; timeout?: number },
  ) => Promise<{ ok: boolean; removed: { label: string; url: string } | null; skipped?: boolean }>;
  makePanelProbe: (
    dropZone: Element | null,
    modal: Element | null,
    doc: Document,
    win: Window,
  ) => () => boolean;
  runFill: (payload: Record<string, unknown>) => Promise<BridgeResult>;
  registerMessageListener: () => boolean;
}

interface BridgeStage {
  stage: string;
  stageLabel: string;
  status: 'ok' | 'notice' | 'failed';
  message: string;
  /** Offset from the start of the run; adjacent values give a step's own duration. */
  elapsedMs?: number;
  /**
   * Sanitized by `messages.sanitizeForLog` before it leaves the page, so treat
   * values as `unknown` rather than assuming the shape the bridge passed in.
   */
  diagnostics: Record<string, unknown>;
}

interface BridgeResult {
  ok: boolean;
  status: 'success' | 'unconfirmed' | 'failed';
  stage: string | null;
  code: string | null;
  message: string;
  stages: BridgeStage[];
  upload: { status: string; confirmed: boolean; strategy: string } | null;
  confirmUpload: {
    clicked: boolean;
    found: boolean;
    panelClosed?: boolean;
    buttonText: string | null;
    waitedMs?: number | null;
    panelCloseWaitedMs?: number | null;
  } | null;
  timings?: {
    totalMs: number;
    waitUploadMs: number | null;
    waitConfirmButtonMs: number | null;
    waitPanelCloseMs: number | null;
  };
}

interface PageHandles {
  window: Window & typeof globalThis;
  bridge: Bridge;
  locator: {
    findVisibleUploadButtons: (doc: Document, win: Window) => {
      domCount: number;
      visibleCount: number;
      visibleItems: Array<{ text: string; element: Element }>;
    };
    findDropZone: (
      doc: Document,
      win: Window,
    ) => { ok: boolean; code?: string; element?: Element; matchedBy?: string };
  };
  domWait: {
    waitFor: (options: Record<string, unknown>) => Promise<{
      ok: boolean;
      timedOut: boolean;
      elapsed: number;
      polls: number;
    }>;
  };
}

/** Captured `chrome.runtime.onMessage` listeners, so the real entry point can be driven. */
let messageListeners: Array<(message: unknown, sender: unknown, send: (value: unknown) => void) => unknown> = [];

function loadVendorChain(): PageHandles {
  messageListeners = [];
  // The bridge installs a module-level idempotency flag, and the libraries hang
  // off `globalThis.AEIIR`; both have to be cleared to re-run the chain.
  delete (globalThis as unknown as Record<string, unknown>).AEIIR;
  (globalThis as unknown as Record<string, unknown>).chrome = {
    runtime: {
      onMessage: {
        addListener: (listener: (typeof messageListeners)[number]) => {
          messageListeners.push(listener);
        },
      },
    },
  };

  for (const file of VENDOR_FILES) {
    // Indirect eval: these IIFEs take the real global object as their root.
    // eslint-disable-next-line no-eval
    (0, eval)(readFileSync(resolve(VENDOR_ROOT, file), 'utf-8'));
  }

  const ns = (globalThis as unknown as Record<
    string,
    { pageFillBridge: Bridge; uploadLocator: PageHandles['locator']; domWait: PageHandles['domWait'] }
  >).AEIIR;
  return {
    window: window as Window & typeof globalThis,
    bridge: ns.pageFillBridge,
    locator: ns.uploadLocator,
    domWait: ns.domWait,
  };
}

/**
 * Stand in for the seller console's upload dialog: opening the panel on the
 * upload button, rendering a thumbnail once the file lands, and applying the
 * image when 「确认上传」 is clicked.
 */
function installFakeUploadPanel(): {
  openClicks: number;
  confirmClicks: number;
  injected: Array<{ name: string; type: string; size: number }>;
  /** `data-index` of the slot whose upload button was clicked, in order. */
  clickedSlots: string[];
  panelIsOpen: () => boolean;
  /** Open the dialog without going through the upload button (the user did it by hand). */
  open: () => void;
} {
  const state = {
    openClicks: 0,
    confirmClicks: 0,
    injected: [] as Array<{ name: string; type: string; size: number }>,
    clickedSlots: [] as string[],
    panelIsOpen: () => document.querySelector('div.material-center-modal') !== null,
    open: () => undefined as void,
  };

  const openPanel = (): void => {
    const modal = document.createElement('div');
    modal.className = 'material-center-modal';
    modal.innerHTML = `
      <div class="material-center-upload-drag">
        <p class="material-center-upload-drag-text">点击此处或者将文件拖至此处</p>
      </div>
      <div class="material-center-upload-list"></div>
      <input type="file" accept="image/png,image/jpeg" />
      <div class="modal-footer">
        <button type="button">前往媒体中心</button>
        <button type="button">确认上传</button>
        <button type="button">取消</button>
      </div>`;
    document.body.appendChild(modal);

    const input = modal.querySelector('input[type="file"]') as HTMLInputElement;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) state.injected.push({ name: file.name, type: file.type, size: file.size });
      // The page rendering a thumbnail is exactly what the flow treats as
      // "the upload happened".
      const list = modal.querySelector('.material-center-upload-list') as HTMLElement;
      const item = document.createElement('div');
      item.className = 'material-center-upload-list-item';
      item.innerHTML = '<img src="blob:preview" alt="preview" />';
      list.appendChild(item);
    });

    for (const node of Array.from(modal.querySelectorAll('button'))) {
      if (node.textContent?.trim() !== '确认上传') continue;
      node.addEventListener('click', () => {
        state.confirmClicks += 1;
        modal.remove();
      });
    }
  };
  state.open = openPanel;

  /**
   * Delegated from the image widget rather than bound to one button.
   *
   * Two reasons: the button that ends up being clicked may only exist AFTER the
   * first image is deleted, and `document` survives `body.innerHTML = FIXTURE`
   * between tests, so listeners bound there would pile up across cases.
   */
  const trigger = document.querySelector('.imageUploadWrap');
  if (!trigger) {
    // Deliberately not falling back to `document.body`: a listener left on body
    // would outlive `body.innerHTML = FIXTURE` and fire during later tests.
    throw new Error('installFakeUploadPanel 需要 .imageUploadWrap：图片区容器是委托挂载点');
  }
  trigger.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest?.('div.image-upload-btn, div.upload-content');
    if (!button) return;
    state.openClicks += 1;
    state.clickedSlots.push(button.closest('.sell-o-image-item')?.getAttribute('data-index') ?? '?');
    openPanel();
  });

  return state;
}

/**
 * Stand in for the REAL upload-dialog timing (2026-09-28).
 *
 * What the live console actually does, and what the old code could not cope with:
 *   1. the thumbnail appears immediately — which is what the upload-wait step
 *      treats as "uploaded", so it returns long before the upload is over;
 *   2. the 「确认上传」 button stays greyed out until the upload finishes;
 *   3. once it does, the panel switches to its list state and the drop zone —
 *      the only anchor the old panel probe had — is removed from the DOM.
 *
 * @param settleMs how long the fake upload takes
 * @param rerender replace the whole modal node on settle, the way React does,
 *   instead of enabling the button in place
 */
function installSlowUploadPanel(options: { settleMs: number; rerender?: boolean }): {
  confirmClicks: number;
  decoyClicks: number;
  panelIsOpen: () => boolean;
} {
  const state = {
    confirmClicks: 0,
    decoyClicks: 0,
    panelIsOpen: () => document.querySelector('.material-center-modal') !== null,
  };

  const buildModal = (): HTMLElement => {
    const modal = document.createElement('div');
    modal.className = 'material-center-modal';
    modal.innerHTML = `
      <div class="material-center-upload-drag">点击此处或者将文件拖至此处</div>
      <div class="material-center-upload-list"></div>
      <input type="file" accept="image/png" />
      <div class="modal-footer">
        <button type="button" class="confirm-upload" disabled>确认上传</button>
      </div>`;
    return modal;
  };

  const wireConfirm = (modal: HTMLElement): void => {
    const button = modal.querySelector('button.confirm-upload') as HTMLButtonElement;
    button.addEventListener('click', () => {
      state.confirmClicks += 1;
      modal.remove();
    });
  };

  const openPanel = (): void => {
    const modal = buildModal();
    document.body.appendChild(modal);
    wireConfirm(modal);

    const input = modal.querySelector('input[type="file"]') as HTMLInputElement;
    input.addEventListener('change', () => {
      const list = modal.querySelector('.material-center-upload-list') as HTMLElement;
      const item = document.createElement('div');
      item.className = 'material-center-upload-list-item';
      item.innerHTML = '<img src="blob:preview" alt="preview" />';
      list.appendChild(item);

      const progress = document.createElement('div');
      progress.className = 'ant-progress';
      modal.appendChild(progress);

      setTimeout(() => {
        progress.remove();
        if (options.rerender) {
          // The whole node is replaced: the modal the flow captured before the
          // upload is now detached, and so is the drop zone it anchored on.
          const replacement = buildModal();
          replacement.querySelector('.material-center-upload-drag')?.remove();
          (replacement.querySelector('button.confirm-upload') as HTMLButtonElement).disabled = false;
          document.body.appendChild(replacement);
          wireConfirm(replacement);
          modal.remove();
          return;
        }
        modal.querySelector('.material-center-upload-drag')?.remove();
        (modal.querySelector('button.confirm-upload') as HTMLButtonElement).disabled = false;
      }, options.settleMs);
    });
  };

  const trigger = document.querySelector('.imageUploadWrap');
  if (!trigger) throw new Error('installSlowUploadPanel 需要 .imageUploadWrap');
  trigger.addEventListener('click', (event) => {
    if (!(event.target as Element | null)?.closest?.('div.image-upload-btn, div.upload-content')) return;
    openPanel();
  });

  return state;
}

/**
 * A panel whose 「确认上传」 never becomes clickable — and which shows no
 * progress bar either. Used to prove the diagnostics can tell "the page is
 * still busy" apart from "we are waiting on the wrong button".
 */
function installStuckConfirmButton(): void {
  const trigger = document.querySelector('.imageUploadWrap');
  if (!trigger) throw new Error('installStuckConfirmButton 需要 .imageUploadWrap');
  trigger.addEventListener('click', (event) => {
    if (!(event.target as Element | null)?.closest?.('div.image-upload-btn, div.upload-content')) return;
    const modal = document.createElement('div');
    modal.className = 'material-center-modal';
    modal.innerHTML = `
      <div class="material-center-upload-drag">点击此处或者将文件拖至此处</div>
      <div class="material-center-upload-list"></div>
      <input type="file" accept="image/png" />
      <div class="modal-footer">
        <button type="button" class="confirm-upload" disabled>确认上传</button>
      </div>`;
    document.body.appendChild(modal);
  });
}

/** A second, unrelated upload dialog whose 「确认上传」 is ready right now. */
function installDecoyUploadPanel(): { clicks: number } {
  const state = { clicks: 0 };
  const modal = document.createElement('div');
  modal.className = 'ant-modal';
  modal.innerHTML = `
    <input type="file" accept="image/png" />
    <div class="modal-footer"><button type="button" class="decoy-confirm">确认上传</button></div>`;
  document.body.appendChild(modal);
  (modal.querySelector('button.decoy-confirm') as HTMLButtonElement).addEventListener('click', () => {
    state.clicks += 1;
  });
  return state;
}

function fillRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    dataUrl: PNG_1X1,
    fileMeta: {
      name: 'aliexpress-composite-20260927-120000.png',
      type: 'image/png',
      size: byteLengthOfDataUrl(PNG_1X1),
    },
    openPanel: true,
    confirmUploadClick: true,
    panelTimeout: 1500,
    uploadTimeout: 1500,
    confirmTimeout: 1500,
    deleteTimeout: 1500,
    ...overrides,
  };
}

/** The real delete-icon path, as captured from the seller console (the fixture trims it). */
const REAL_REMOVE_PATH = 'M601.344 73.984a1 1 0 0 0-1.414 0L593 80.914a1 1 0 0 0 1.414 1.415l6.93-6.93 6.93 6.93';

/**
 * Make the first image's delete icon behave like the live console: clicking it
 * removes that slot, and the later images shift forward — so the freed slot ends
 * up LAST, never at position 0.
 */
function installShiftForwardOnDelete(): { deletes: number } {
  const state = { deletes: 0 };
  document.querySelector('[data-index="0"] .image-upload-remove')?.addEventListener('click', () => {
    state.deletes += 1;
    document.querySelector('[data-index="0"]')?.remove();
  });
  return state;
}

/**
 * The other plausible page behaviour: the slot stays where it is and simply
 * becomes an empty upload slot again. The flow must not assume either one.
 */
function installEmptyInPlaceOnDelete(): { deletes: number } {
  const state = { deletes: 0 };
  document.querySelector('[data-index="0"] .image-upload-remove')?.addEventListener('click', () => {
    state.deletes += 1;
    const slot = document.querySelector('[data-index="0"]') as HTMLElement;
    slot.className = 'sell-o-image-item';
    slot.innerHTML =
      '<div class="image-upload-btn"><div class="upload-text-wrap"><span>上传图片</span></div></div>';
  });
  return state;
}

describe('page-fill bridge — slot choice', () => {
  let page: PageHandles;

  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    page = loadVendorChain();
  });

  it('targets the empty slot so the new image is appended, not overwritten', () => {
    const survey = page.locator.findVisibleUploadButtons(document, window);
    // The fixture has ONE upload entry (image-upload-btn wrapping upload-content,
    // which must count as a single entry, not two), and it lives on the empty slot.
    expect(survey.visibleCount).toBe(1);

    const choice = page.bridge.chooseUploadButton(survey);
    expect(choice).not.toBeNull();
    expect(choice?.emptyCount).toBe(1);
    expect(choice?.filledCount).toBe(0);
    expect(choice?.item.text).toBe('上传图片');
  });

  it('returns null when every slot is occupied — that click would overwrite an image', () => {
    // Real-device lesson (2026-09-28): opening the panel from a FILLED slot's
    // entry makes 「确认上传」 overwrite that image. So there is no "degrade to
    // the first button" fallback any more: no empty-slot entry means refuse.
    const slot = document.querySelector('[data-index="5"]') as HTMLElement;
    slot.classList.add('has-url');

    const survey = page.locator.findVisibleUploadButtons(document, window);
    expect(survey.visibleCount).toBe(1);
    expect(page.bridge.chooseUploadButton(survey)).toBeNull();
  });

  it('finds the live entry (div.upload-content) and picks the LAST empty slot', () => {
    // Real console (2026-09-28): the entry is div.upload-content on its own, and
    // the panel binds to the slot it was opened from — so the LAST empty slot's
    // entry is the one that appends the new image at the end.
    for (const index of ['3', '5']) {
      const slot = document.querySelector(`[data-index="${index}"]`) as HTMLElement;
      slot.classList.remove('has-url');
      slot.innerHTML =
        '<div class="upload-content"><span class="anticon upload-btn-icon"></span>' +
        '<div class="upload-text-wrap"><span>上传图片</span></div></div>';
    }

    const survey = page.locator.findVisibleUploadButtons(document, window);
    expect(survey.visibleCount).toBe(2);

    const choice = page.bridge.chooseUploadButton(survey);
    expect(choice).not.toBeNull();
    expect(choice?.emptyCount).toBe(2);
    expect(choice?.item.element.closest('.sell-o-image-item')?.getAttribute('data-index')).toBe('5');
  });

  it('refuses an entry that says 视频 — clicking it opens the video upload window', () => {
    // Real device (2026-09-28): clicking the wrong entry popped the video upload
    // dialog. The right entry says 「上传图片」, so the text is a cheap guard.
    const slot = document.querySelector('[data-index="5"]') as HTMLElement;
    slot.innerHTML =
      '<div class="upload-content"><div class="upload-text-wrap"><span>上传视频</span></div></div>';

    const survey = page.locator.findVisibleUploadButtons(document, window);
    expect(survey.visibleCount).toBe(1);

    expect(page.bridge.chooseUploadButton(survey)).toBeNull();
    expect(page.bridge.skippedEntriesOf(survey)).toEqual([
      { text: '上传视频', reason: 'video-entry' },
    ]);
  });

  it('refuses an entry on a slot outside the image area (SKU module)', () => {
    // The fixture ships a `.sell-o-image-item` OUTSIDE `.imageUploadWrap`. It has
    // the very same class name, so "has a slot ancestor" is not enough to trust
    // an entry — the slot has to be inside the product image widget.
    const skuSlot = document.querySelector('.skuImageSection .sell-o-image-item') as HTMLElement;
    skuSlot.classList.remove('has-url');
    skuSlot.innerHTML =
      '<div class="upload-content"><div class="upload-text-wrap"><span>上传图片</span></div></div>';

    const survey = page.locator.findVisibleUploadButtons(document, window);
    expect(survey.visibleCount).toBe(2);

    const choice = page.bridge.chooseUploadButton(survey);
    expect(choice?.emptyCount).toBe(1);
    expect(choice?.item.element.closest('.sell-o-image-item')?.getAttribute('data-index')).toBe('5');
    expect(page.bridge.skippedEntriesOf(survey)).toContainEqual({
      text: '上传图片',
      reason: 'outside-image-area',
    });
  });

  it('tells an occupied slot from an empty one the same way the scanner does', () => {
    const filled = document.querySelector('[data-index="0"]');
    const empty = document.querySelector('[data-index="5"]');

    expect(page.bridge.isFilledSlot(filled)).toBe(true);
    expect(page.bridge.isFilledSlot(empty)).toBe(false);
    // The empty slot's button resolves to that same slot.
    expect(page.bridge.slotOf(empty?.querySelector('div.image-upload-btn') ?? null)).toBe(empty);
  });

  it('counts slots inside the image widget only, not the SKU module that reuses the class', () => {
    // The fixture also has a `.sell-o-image-item.has-url` in the SKU module.
    // Counting it would make an empty area look one slot away from full.
    const slots = page.bridge.surveySlots(document);

    expect(slots).toEqual({ total: 6, filled: 5 });
  });
});

describe('page-fill bridge — runFill', () => {
  let page: PageHandles;

  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    page = loadVendorChain();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clicks the upload button, injects the PNG, and confirms the upload', async () => {
    const panel = installFakeUploadPanel();

    const result = await page.bridge.runFill(fillRequest());

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(panel.openClicks).toBe(1);
    expect(panel.confirmClicks).toBe(1);
    expect(result.upload?.strategy).toBe('input');
    expect(result.confirmUpload?.clicked).toBe(true);
    expect(result.confirmUpload?.buttonText).toBe('确认上传');
    // The panel really did close, which is the strongest signal available that
    // the image was applied rather than merely staged.
    expect(result.confirmUpload?.panelClosed).toBe(true);
    expect(panel.panelIsOpen()).toBe(false);
  });

  it('opens the panel from the live entry (div.upload-content) and lands in the last slot', async () => {
    // Real console (2026-09-28): the entry renders as div.upload-content without
    // the old image-upload-btn wrapper. The flow must click it — and, because the
    // panel binds to the slot it was opened from, the image ends up in slot 5.
    const panel = installFakeUploadPanel();
    const slot = document.querySelector('[data-index="5"]') as HTMLElement;
    slot.innerHTML =
      '<div class="upload-content"><div class="upload-text-wrap"><span>上传图片</span></div></div>';

    const result = await page.bridge.runFill(fillRequest());

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(panel.openClicks).toBe(1);
    expect(panel.clickedSlots).toEqual(['5']);
  });

  it('injects the exported file under its real name, type and byte length', async () => {
    const panel = installFakeUploadPanel();

    await page.bridge.runFill(fillRequest());

    expect(panel.injected).toHaveLength(1);
    expect(panel.injected[0]).toEqual({
      name: 'aliexpress-composite-20260927-120000.png',
      type: 'image/png',
      size: byteLengthOfDataUrl(PNG_1X1),
    });
  });

  it('records every step it took, in order', async () => {
    installFakeUploadPanel();

    const result = await page.bridge.runFill(fillRequest());

    expect(result.stages.map((stage) => stage.stage)).toEqual([
      'OPEN_PANEL',
      'FIND_DROP_ZONE',
      'FIND_FILE_INPUT',
      'INJECT_FILE',
      'WAIT_UPLOAD',
      'CONFIRM_UPLOAD',
    ]);
    expect(result.stages.every((stage) => stage.status !== 'failed')).toBe(true);
  });

  it('skips the panel click when the panel is already open (cross-frame retry)', async () => {
    const panel = installFakeUploadPanel();
    // Pre-open the panel the way a first attempt in another frame would have.
    (document.querySelector('div.image-upload-btn') as HTMLElement).click();

    const result = await page.bridge.runFill(fillRequest({ openPanel: false }));

    expect(result.ok).toBe(true);
    expect(result.stages.some((stage) => stage.stage === 'OPEN_PANEL')).toBe(false);
    // Only the pre-opening click happened; the bridge must not click again.
    expect(panel.openClicks).toBe(1);
  });

  it('reports UPLOAD_PANEL_NOT_FOUND when the panel never appears', async () => {
    // No fake panel installed: the click goes nowhere.
    const result = await page.bridge.runFill(fillRequest({ panelTimeout: 120 }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    // This exact code is what makes the service worker try another frame.
    expect(result.code).toBe('UPLOAD_PANEL_NOT_FOUND');
    expect(result.stage).toBe('FIND_DROP_ZONE');
  });

  it('blames the full image slots, not a shut panel, when no upload button is left', async () => {
    // The real console renders `div.image-upload-btn` ONLY on empty slots, so a
    // full image area has no button anywhere — not a hidden one. The old message
    // ("go open the upload panel") would send the user hunting for a control that
    // does not exist, when the only real fix is to free a slot.
    const slot = document.querySelector('[data-index="5"]') as HTMLElement;
    slot.classList.add('has-url');
    slot.querySelector('.image-upload-btn')?.remove();

    const result = await page.bridge.runFill(fillRequest({ panelTimeout: 120 }));

    expect(result.ok).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.stage).toBe('OPEN_PANEL');
    expect(result.code).toBe('UPLOAD_BUTTON_NOT_FOUND');
    expect(result.message).toContain('图片位已经全部占用');
    expect(result.message).toContain('6 个槽位');
    expect(result.message).not.toContain('上传面板');

    // The diagnostics must carry enough to tell the two causes apart after the fact.
    const [first] = result.stages;
    expect(first?.diagnostics.allSlotsFull).toBe(true);
    expect(first?.diagnostics.slotCount).toBe(6);
    expect(first?.diagnostics.filledSlotCount).toBe(6);
    expect(first?.diagnostics.visibleUploadButtonCount).toBe(0);
  });

  it('keeps the open-the-panel advice when the slots are not the reason', async () => {
    // Slot 5 stays empty but its button vanished: that is a layout/version change,
    // and opening the panel by hand genuinely is the next thing to try.
    document.querySelector('.image-upload-btn')?.remove();

    const result = await page.bridge.runFill(fillRequest({ panelTimeout: 120 }));

    expect(result.stage).toBe('OPEN_PANEL');
    expect(result.code).toBe('UPLOAD_BUTTON_NOT_FOUND');
    expect(result.message).toContain('请先在商品页把图片上传面板打开');
    expect(result.message).not.toContain('全部占用');
    expect(result.stages[0]?.diagnostics.allSlotsFull).toBe(false);
  });

  it('clicks the freshly rendered 「确认上传」 even while a stale one is still in the DOM', async () => {
    // Real-device bug (2026-09-28): once the upload finishes the panel switches
    // to its "added images" list state, and React renders the new footer before
    // unmounting the old one. Two 「确认上传」 buttons then coexist, the stale one
    // still disabled. Requiring "exactly one enabled button" made the flow wait
    // for the old node to disappear — the seller saw a clickable button and
    // nothing happening for seconds.
    const panel = installFakeUploadPanel();
    // No upload entry left, so the run reuses the already-open panel instead of
    // opening a second one (which would leave the stale button in the wrong dialog).
    document.querySelector('.image-upload-btn')?.remove();
    panel.open();

    const footer = document.querySelector('div.material-center-modal .modal-footer');
    if (!footer) throw new Error('夹具需要 .modal-footer');
    const stale = document.createElement('button');
    stale.type = 'button';
    stale.className = 'stale-confirm';
    stale.disabled = true;
    stale.textContent = '确认上传';
    let staleClicks = 0;
    stale.addEventListener('click', () => {
      staleClicks += 1;
    });
    footer.insertBefore(stale, footer.firstChild);

    const result = await page.bridge.runFill(fillRequest());

    expect(result.ok).toBe(true);
    // The stale node must not win, and the fresh one must still be clicked.
    expect(staleClicks).toBe(0);
    expect(panel.confirmClicks).toBe(1);
    expect(result.confirmUpload?.clicked).toBe(true);
  });

  it('resumes when the user already opened the panel by hand, instead of failing again', async () => {
    // "Open the panel yourself" must not be a dead end: the user does it, clicks
    // 回填 again, and the button is still missing because the page renders it only
    // on empty slots. The flow has to notice the open panel and carry on.
    const panel = installFakeUploadPanel();
    document.querySelector('.image-upload-btn')?.remove();
    panel.open();

    const result = await page.bridge.runFill(fillRequest());

    expect(result.ok).toBe(true);
    expect(panel.openClicks).toBe(0);
    expect(panel.confirmClicks).toBe(1);

    const openStage = result.stages.find((stage) => stage.stage === 'OPEN_PANEL');
    expect(openStage?.diagnostics.reusedOpenPanel).toBe(true);
    // Reusing an open panel is not a caveat the user has to act on, so it must
    // stay out of the warning channel the editor renders in red.
    expect(result.stages.some((stage) => stage.status === 'notice' && stage.stage === 'OPEN_PANEL')).toBe(false);
  });

  it('refuses a non-PNG payload instead of uploading it', async () => {
    installFakeUploadPanel();

    const result = await page.bridge.runFill(fillRequest({ dataUrl: 'data:image/png;base64,QUJD' }));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('INJECT_FILE');
    // Magic-byte mismatch: the base64 says PNG, the bytes say otherwise.
    expect(result.code).toBe('IMAGE_MAGIC_MISMATCH');
  });

  it('still succeeds, with a notice, when there is no 「确认上传」 button to click', async () => {
    // Panel without a confirm button: some layouts apply on drop.
    document.querySelector('div.image-upload-btn')?.addEventListener('click', () => {
      const modal = document.createElement('div');
      modal.className = 'material-center-modal';
      modal.innerHTML = `
        <div class="material-center-upload-drag">点击此处或者将文件拖至此处</div>
        <div class="material-center-upload-list"></div>
        <input type="file" accept="image/png" />`;
      document.body.appendChild(modal);
      const input = modal.querySelector('input[type="file"]') as HTMLInputElement;
      input.addEventListener('change', () => {
        const item = document.createElement('div');
        item.className = 'material-center-upload-list-item';
        item.innerHTML = '<img src="blob:preview" />';
        (modal.querySelector('.material-center-upload-list') as HTMLElement).appendChild(item);
      });
    });

    const result = await page.bridge.runFill(fillRequest({ confirmTimeout: 200 }));

    expect(result.ok).toBe(true);
    expect(result.confirmUpload?.clicked).toBe(false);
    expect(result.stages.some((stage) => stage.stage === 'CONFIRM_UPLOAD' && stage.status === 'notice')).toBe(true);
  });

  it('waits for a slow upload to finish before clicking 「确认上传」', async () => {
    // Real console (2026-09-28): the thumbnail arrives instantly, so the upload
    // wait is satisfied long before the image has actually been uploaded — and
    // until then the button is greyed out. An 8s ceiling used to expire mid-way,
    // leaving the dialog on screen with nobody left to click it.
    const panel = installSlowUploadPanel({ settleMs: 200 });

    const result = await page.bridge.runFill(fillRequest({ confirmTimeout: 3000 }));

    expect(result.status).toBe('success');
    expect(panel.confirmClicks).toBe(1);
    expect(result.confirmUpload?.clicked).toBe(true);
    expect(result.confirmUpload?.panelClosed).toBe(true);
    expect(panel.panelIsOpen()).toBe(false);
  });

  it('still finds 「确认上传」 when the panel is re-rendered during the upload', async () => {
    // The sequel: React swaps the whole modal node, so both anchors the flow
    // captured before uploading (the drop zone and the modal root) are detached
    // at the exact moment the button becomes clickable.
    const panel = installSlowUploadPanel({ settleMs: 200, rerender: true });

    const result = await page.bridge.runFill(fillRequest({ confirmTimeout: 3000 }));

    expect(result.status).toBe('success');
    expect(panel.confirmClicks).toBe(1);
    expect(result.confirmUpload?.clicked).toBe(true);
  });

  it('never clicks another dialog’s 「确认上传」 while this upload is still running', async () => {
    // The tempting shortcut is a whole-document scan, which would find the decoy
    // button immediately. Only one upload panel may be trusted as ours.
    const panel = installSlowUploadPanel({ settleMs: 60_000 });
    const decoy = installDecoyUploadPanel();

    const result = await page.bridge.runFill(fillRequest({ confirmTimeout: 400 }));

    expect(decoy.clicks).toBe(0);
    expect(panel.confirmClicks).toBe(0);
    expect(result.confirmUpload?.clicked).toBe(false);
    const stage = result.stages.find((entry) => entry.stage === 'CONFIRM_UPLOAD');
    expect(stage?.status).toBe('notice');
    expect(stage?.message).toContain('一直不可点击');
  });
});

describe('page-fill bridge — remove first image', () => {
  let page: PageHandles;

  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    page = loadVendorChain();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes the first image before opening the panel, and says which one it deleted', async () => {
    const panel = installFakeUploadPanel();
    const deletes = installShiftForwardOnDelete();

    const result = await page.bridge.runFill(fillRequest({ removeFirstImage: true }));

    expect(result.ok).toBe(true);
    expect(result.status).toBe('success');
    expect(deletes.deletes).toBe(1);
    expect(panel.confirmClicks).toBe(1);

    const order = result.stages.map((stage) => stage.stage);
    // Deleting first is not cosmetic: it re-lays-out the image area, and the
    // empty slot's upload button moves with it, so the slot choice has to happen
    // after the delete.
    expect(order.indexOf('DELETE_IMAGE')).toBeLessThan(order.indexOf('OPEN_PANEL'));
    expect(order).toContain('WAIT_IMAGE_REMOVED');

    // The seller has to be able to see WHICH image was thrown away.
    expect(result.message).toContain('已删除原来的第 1 张图');
    expect(result.message).toContain('商品正面图');
  });

  it('frees a slot that the flow then uploads into, even though the free slot is the last one', async () => {
    // AliExpress shifts the later images forward, so after deleting slot 0 the
    // only empty slot is the last one. The point of the delete is to HAVE a free
    // slot, not to control where the new image ends up.
    const panel = installFakeUploadPanel();
    installShiftForwardOnDelete();

    const result = await page.bridge.runFill(fillRequest({ removeFirstImage: true }));

    expect(result.status).toBe('success');
    expect(panel.injected).toHaveLength(1);
    expect(panel.clickedSlots).toEqual(['5']);
  });

  it('appends into the LAST empty slot even when the page frees slot 0 in place', async () => {
    // The opposite page behaviour: slot 0 itself becomes empty again. The flow
    // still appends at the END — the last empty slot — because the panel binds to
    // the slot it was opened from, and landing in the main position would silently
    // make the new image the main image. The gap at slot 0 stays for the seller.
    const panel = installFakeUploadPanel();
    installEmptyInPlaceOnDelete();

    const result = await page.bridge.runFill(fillRequest({ removeFirstImage: true }));

    expect(result.status).toBe('success');
    expect(panel.clickedSlots).toEqual(['5']);
  });

  it('leaves every image alone unless the delete was explicitly asked for', async () => {
    const panel = installFakeUploadPanel();
    const deletes = installShiftForwardOnDelete();

    const result = await page.bridge.runFill(fillRequest());

    expect(result.ok).toBe(true);
    expect(deletes.deletes).toBe(0);
    expect(result.stages.some((stage) => stage.stage === 'DELETE_IMAGE')).toBe(false);
    expect(result.message).not.toContain('已删除');
    expect(panel.clickedSlots).toEqual(['5']);
  });

  it('refuses to click anything else when the delete icon is missing', async () => {
    const panel = installFakeUploadPanel();
    document.querySelector('[data-index="0"] .image-upload-remove')?.remove();

    const result = await page.bridge.runFill(fillRequest({ removeFirstImage: true, deleteTimeout: 120 }));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('FIND_DELETE_BUTTON');
    expect(result.code).toBe('DELETE_BUTTON_NOT_FOUND');
    // Names the image it could not delete, so the seller knows what to do by hand.
    expect(result.stages[0]?.diagnostics.slotLabel).toBe('商品正面图');
    // Nothing else happened: no other button was clicked, no panel was opened.
    expect(panel.openClicks).toBe(0);
  });

  it('stops instead of guessing when the image does not actually disappear', async () => {
    // A confirmation dialog would leave the image sitting there. Clicking "OK" in
    // a dialog we have never seen is exactly the guess this flow refuses to make.
    const panel = installFakeUploadPanel();
    document.querySelector('[data-index="0"] .image-upload-remove')?.addEventListener('click', () => {
      /* the page is waiting for a confirm dialog and does nothing */
    });

    const result = await page.bridge.runFill(fillRequest({ removeFirstImage: true, deleteTimeout: 120 }));

    expect(result.ok).toBe(false);
    expect(result.stage).toBe('WAIT_IMAGE_REMOVED');
    expect(result.code).toBe('DELETE_TIMEOUT');
    expect(result.message).toContain('二次确认');
    expect(panel.openClicks).toBe(0);
    expect(panel.injected).toHaveLength(0);
  });

  it('does not go hunting through the document when the image area is missing', async () => {
    // Deleting is destructive, so a missing widget is a stop — not a reason to
    // delete whatever `.sell-o-image-item` happens to exist elsewhere.
    document.querySelector('.imageUploadWrap')?.classList.remove('imageUploadWrap');

    const result = await page.bridge.runFill(fillRequest({ removeFirstImage: true, deleteTimeout: 120 }));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('IMAGE_AREA_NOT_FOUND');
    expect(result.message).toContain('.imageUploadWrap');
  });

  it('finds the delete icon by its SVG path when the class name has changed', async () => {
    installFakeUploadPanel();
    const icon = document.querySelector('[data-index="0"] .image-upload-remove') as Element;
    const deletes = installShiftForwardOnDelete();
    // Rename the class and give the icon the REAL path captured from the console:
    // only the path fallback can find it now.
    icon.classList.remove('image-upload-remove');
    (icon.querySelector('path') as SVGPathElement).setAttribute('d', REAL_REMOVE_PATH);

    const slot = document.querySelector('[data-index="0"]') as Element;
    const found = page.bridge.findRemoveIcon(slot);

    expect(found).not.toBeNull();
    // The delete icon, not its neighbour `image-upload-edit` (path `M817 840`).
    expect(icon.contains(found as Node)).toBe(true);

    const result = await page.bridge.runFill(fillRequest({ removeFirstImage: true }));

    // Finding the icon is only half of it. This node is an <svg>, which has no
    // click() — so the bridge has to DISPATCH the pointer sequence instead, and
    // the fallback node still has to be the one the page listens on. A click that
    // silently did nothing would leave `deletes` at 0.
    expect(result.status).toBe('success');
    expect(deletes.deletes).toBe(1);
    expect(result.message).toContain('已删除原来的第 1 张图');

    // Pin the mechanism, not just the outcome: the full pointer sequence was
    // dispatched, and it degraded to no-view events. Regression guard for a real
    // bug — passing an unacceptable object as MouseEventInit.view throws
    // ("member view is not of type Window") and turned a working click into a
    // hard failure, because view is only a convenience field.
    const deleteStage = result.stages.find((s) => s.stage === 'DELETE_IMAGE');
    expect(deleteStage?.diagnostics.clickMethods).toEqual([
      'pointerdown(no-view)', 'mousedown(no-view)', 'pointerup(no-view)',
      'mouseup(no-view)', 'click(no-view)',
    ]);
  });

  it('carries on when the image area has nothing to delete yet', async () => {
    // A brand-new product with no images: deletion is a no-op, and that is not an
    // error — the new image just goes into the first free slot.
    document.body.innerHTML = `
      <div class="imageUploadWrap">
        <div class="sell-o-image-item">
          <div class="image-upload-btn"><div class="upload-text-wrap"><span>上传图片</span></div></div>
        </div>
      </div>`;
    const panel = installFakeUploadPanel();

    const result = await page.bridge.runFill(fillRequest({ removeFirstImage: true }));

    expect(result.ok).toBe(true);
    expect(result.stages.find((stage) => stage.stage === 'FIND_DELETE_BUTTON')?.message).toContain('无需删除');
    expect(result.stages.some((stage) => stage.stage === 'DELETE_IMAGE')).toBe(false);
    expect(result.message).not.toContain('已删除');
    expect(panel.injected).toHaveLength(1);
  });
});

describe('page-fill bridge — panel probe', () => {
  let page: PageHandles;

  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    page = loadVendorChain();
  });

  it('keeps reporting an open panel after the drag zone is swapped for the result list', () => {
    // Real-device regression (2026-09-28 screenshot): once the upload succeeds the
    // panel switches to the 「已添加图片」 list state and REMOVES the drag zone.
    // A probe anchored only on the drag zone then reports "panel closed", the flow
    // skips 「确认上传」 as "applied on drop", and the dialog is stuck on screen.
    // With the modal root still connected the panel IS still open.
    installFakeUploadPanel();
    (document.querySelector('div.image-upload-btn') as HTMLElement).click();

    const zone = page.locator.findDropZone(document, window);
    expect(zone.ok).toBe(true);
    const modal = document.querySelector('div.material-center-modal');
    const probe = page.bridge.makePanelProbe(zone.element as Element, modal, document, window);
    expect(probe()).toBe(true);

    (document.querySelector('div.material-center-upload-drag') as HTMLElement).remove();
    expect(probe()).toBe(true);

    // Only when both anchors are gone (and a rescan cannot find a drop zone that
    // actually sits inside a modal) is the panel really closed.
    (document.querySelector('div.material-center-modal') as HTMLElement).remove();
    expect(probe()).toBe(false);
  });

  it('never reads a failed scan (or the document body) as an open panel', () => {
    // findDropZone returns no `element` when it fails, so callers that fall back
    // to document.body would otherwise pin the probe to an always-connected node.
    const failed = page.locator.findDropZone(document, window);
    expect(failed.ok).toBe(false);
    expect(failed.element).toBeUndefined();

    expect(page.bridge.makePanelProbe(document.body, null, document, window)()).toBe(false);
  });
});

describe('page-fill bridge — message entry point', () => {
  let page: PageHandles;

  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    page = loadVendorChain();
  });

  it('registers exactly one listener and ignores foreign message types', async () => {
    expect(messageListeners).toHaveLength(1);
    expect(page.bridge.registerMessageListener()).toBe(true);

    const ignored = messageListeners[0]?.({ type: 'REPLACE_PAGE_IMAGE' }, {}, () => undefined);
    expect(ignored).toBe(false);
  });

  it('answers the bridge message asynchronously with the flow result', async () => {
    installFakeUploadPanel();

    const answer = await new Promise((resolve) => {
      const keepOpen = messageListeners[0]?.(
        { type: 'AIEE_PAGE_FILL_EXECUTE', payload: fillRequest() },
        {},
        resolve,
      );
      expect(keepOpen).toBe(true);
    });

    expect((answer as BridgeResult).status).toBe('success');
  });

  it('is idempotent: a second injection must not register a second listener', () => {
    // The service worker re-injects the chain on every frame hop, and a doubled
    // listener would run the whole flow twice.
    const before = messageListeners.length;
    (0, eval)(readFileSync(resolve(VENDOR_ROOT, 'bridge.js'), 'utf-8'));
    expect(messageListeners).toHaveLength(before);
  });
});

describe('timing instrumentation', () => {
  let page: PageHandles;

  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    page = loadVendorChain();
  });

  /**
   * A slow fill used to be undiagnosable: the result only carried the run's
   * total, so "the upload was slow" and "we waited on the confirm button"
   * looked identical from the outside.
   */
  it('stamps every stage with an offset from the start of the run', async () => {
    installFakeUploadPanel();

    const result = await page.bridge.runFill(fillRequest());

    expect(result.status).toBe('success');
    expect(result.stages.length).toBeGreaterThan(1);
    for (const stage of result.stages) {
      expect(typeof stage.elapsedMs).toBe('number');
    }
    // Offsets are cumulative, so they must never go backwards.
    const offsets = result.stages.map((stage) => stage.elapsedMs ?? 0);
    const sorted = [...offsets].sort((a, b) => a - b);
    expect(offsets).toEqual(sorted);
  });

  it('breaks the total down into the waits that actually cost time', async () => {
    installFakeUploadPanel();

    const result = await page.bridge.runFill(fillRequest());

    expect(result.timings).toBeDefined();
    expect(typeof result.timings?.totalMs).toBe('number');
    // The upload wait is reported by the injector; the confirm wait by the bridge.
    expect(typeof result.timings?.waitUploadMs).toBe('number');
    expect(typeof result.timings?.waitConfirmButtonMs).toBe('number');
    expect(result.confirmUpload?.waitedMs).toBe(result.timings?.waitConfirmButtonMs);
  });

  it('reports how long the button stayed unclickable, so a slow page is distinguishable from a wrong button', async () => {
    // Button exists but stays disabled: the diagnostics must say so rather than
    // just reporting a timeout, otherwise "page was busy" and "we looked in the
    // wrong place" read the same.
    installStuckConfirmButton();

    const result = await page.bridge.runFill(fillRequest({ confirmTimeout: 1200 }));

    const confirm = result.stages.find((stage) => stage.stage === 'CONFIRM_UPLOAD');
    expect(confirm?.status).toBe('notice');
    const diagnostics = confirm?.diagnostics as {
      lastSnapshot?: { disabledStalledMs?: number; uploadBusy?: boolean; progressElements?: number };
    };
    // Long enough for more than one poll: with a single poll the button becomes
    // "stalled" and the final snapshot is taken in the same millisecond, so the
    // stalled duration would legitimately read 0.
    expect(diagnostics.lastSnapshot?.disabledStalledMs).toBeGreaterThan(0);
    // And it must not have mistaken the page's own progress bars for an upload
    // in flight — otherwise "still uploading" would be true forever.
    expect(diagnostics.lastSnapshot?.uploadBusy).toBe(false);
  });
});

describe('polling throttle', () => {
  let page: PageHandles;

  beforeEach(() => {
    document.body.innerHTML = FIXTURE;
    page = loadVendorChain();
  });

  it('compresses a mutation storm instead of re-scanning the document on every callback', async () => {
    // On a heavy seller page a MutationObserver rooted at `document` fires on
    // every repaint; running a full-document scan each time makes the page — and
    // therefore the button we are waiting for — slower.
    let calls = 0;
    const storms: number[] = [];
    const target = document.createElement('div');
    document.body.appendChild(target);

    const stop = window.setInterval(() => {
      const node = document.createElement('span');
      node.textContent = String(storms.length);
      target.appendChild(node);
      storms.push(storms.length);
    }, 5);

    const waited = await page.domWait.waitFor({
      doc: document,
      win: window,
      stage: 'THROTTLE_PROBE',
      description: 'throttled probe',
      timeout: 1000,
      pollInterval: 5,
      throttleMs: 60,
      observeTarget: document,
      check: () => {
        calls += 1;
        return { done: storms.length >= 30, snapshot: { calls } };
      },
    });

    window.clearInterval(stop);
    target.remove();

    expect(waited.ok).toBe(true);
    // ~150ms of storming at 5ms intervals would be ~30 callbacks unthrottled;
    // throttled to 60ms it must be a small fraction of that.
    expect(calls).toBeLessThan(12);
  });

  it('still resolves promptly when the condition is already true', async () => {
    const started = Date.now();
    const waited = await page.domWait.waitFor({
      doc: document,
      win: window,
      stage: 'THROTTLE_PROBE',
      description: 'already true',
      timeout: 1000,
      pollInterval: 60,
      throttleMs: 60,
      observeTarget: document,
      check: () => ({ done: true, value: { ok: true } }),
    });

    expect(waited.ok).toBe(true);
    // The first check must not be deferred by the throttle window.
    expect(Date.now() - started).toBeLessThan(200);
  });
});
