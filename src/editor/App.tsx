import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AUTO_CLOSE_FALLBACK_MS, CANVAS_SIZE, FILL_AUTO_CLOSE_MS, PAGE_FILL_MAX_BYTES, STORAGE_KEYS } from '../shared/constants';
import { AppError, ErrorCode, messageOf } from '../shared/errors';
import { createRequestId, sendToBackground } from '../shared/messages';
import type {
  EditorMaterial,
  EditorSessionMeta,
  ExportInput,
  ImageLayer,
  LayerPatch,
  PageFillResult,
} from '../shared/types';
import { DEFAULT_TEXT_STYLE, pickTextStyle, type TextStyleDefaults } from '../shared/text-style';
import { downloadBlobInPage } from '../services/downloader';
import { blobToDataUrl, buildExportFileName, exportStageToPng } from '../services/exporter';
import { readBlobSize } from '../services/image-size';
import {
  clearTextDefaults,
  loadTextDefaults,
  saveTextDefaults,
} from '../services/text-defaults';
import { describeUploadOutcome } from '../services/upload-images';
import { EditorStage, type EditorStageHandle } from './components/EditorStage';
import { LayerPanel } from './components/LayerPanel';
import { MaterialPanel } from './components/MaterialPanel';
import { Toolbar } from './components/Toolbar';
import { autoCloseStep } from './state/auto-close';
import {
  createEditorState,
  createLayerFromMaterial,
  createTextLayer,
  editorReducer,
  findLayer,
} from './state/editor-reducer';
import { canRedo, canUndo } from './state/history';
import { useEditorSession } from './state/use-editor-session';
import { useImageMap } from './state/use-image-map';
import { usePasteImages } from './state/use-paste-images';
import { useWatermark } from './state/use-watermark';

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

/**
 * How long an operation notice stays on the status bar.
 *
 * Errors linger longer than successes on purpose: a download confirmation is a
 * nicety the user can also see in their downloads folder, whereas a failure is
 * the only place the reason is ever shown.
 */
const NOTICE_TIMEOUT_MS: Record<Notice['kind'], number> = { ok: 6000, error: 9000 };

export function App(): JSX.Element {
  const sessionId = useMemo(() => new URLSearchParams(window.location.search).get('session'), []);
  const { loading, fatalError, materials, statusByImageId, initialDocument, progress, retryCutout, addUploadedImages } =
    useEditorSession(sessionId);

  const [state, dispatch] = useReducer(editorReducer, undefined, () => createEditorState());
  // Raw setter: always go through `showNotice` so the dismiss timer is armed.
  const [notice, setNoticeState] = useState<Notice | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  /**
   * Seconds left before this editor closes itself, or null when no close is
   * pending. Drives the status-bar countdown only — the authoritative value is
   * the deadline in `autoCloseDeadlineRef`, so a throttled timer in a background
   * tab can make the LABEL lag but can never delay the close itself.
   */
  const [autoCloseSecondsLeft, setAutoCloseSecondsLeft] = useState<number | null>(null);
  /**
   * The countdown ran out but the fill is still going, so the close is on hold.
   * Only changes the wording of the status-bar label — `autoCloseStep` decides.
   */
  const [autoCloseWaitingForFill, setAutoCloseWaitingForFill] = useState(false);
  const autoCloseTimerRef = useRef<number | null>(null);
  const autoCloseDeadlineRef = useRef<number | null>(null);
  /**
   * Whether the page fill that armed this countdown has reported back.
   *
   * Starts `true` because "nothing in flight" is what an idle editor is, and it
   * is also the right reading for a countdown armed on a failure that never
   * reached the worker at all.
   */
  const fillSettledRef = useRef(true);
  /**
   * Whether the in-flight PNG job is the page fill rather than a download.
   * Purely cosmetic (it picks which button says「…中」) — `state.exporting` is
   * what actually locks both buttons while either job runs.
   */
  const [filling, setFilling] = useState(false);
  /**
   * Delete the product's current first image before filling back.
   *
   * Defaults to ON because a product that already uses all six slots has no free
   * slot to append to, and freeing one is the only way that fill-back can work.
   * Kept as editor state rather than persisted: an unpersisted default means the
   * checkbox is impossible to leave in a surprising state across sessions.
   */
  const [removeFirstImage, setRemoveFirstImage] = useState(true);

  /**
   * Show a notice, then let it clear itself.
   *
   * Re-arming on every call is what lets a second notice take over from the
   * first instead of being cut short by the first one's pending timer.
   */
  const showNotice = useCallback((next: Notice) => {
    setNoticeState(next);
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
    noticeTimerRef.current = window.setTimeout(() => {
      noticeTimerRef.current = null;
      setNoticeState(null);
    }, NOTICE_TIMEOUT_MS[next.kind]);
  }, []);

  // A timer armed just before teardown must not fire into an unmounted tree.
  useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current);
      if (autoCloseTimerRef.current !== null) window.clearInterval(autoCloseTimerRef.current);
    },
    [],
  );

  /** Drop a pending auto-close. Used by the cancel button, and by every new fill. */
  const cancelAutoClose = useCallback(() => {
    if (autoCloseTimerRef.current !== null) {
      window.clearInterval(autoCloseTimerRef.current);
      autoCloseTimerRef.current = null;
    }
    autoCloseDeadlineRef.current = null;
    // Also releases the fill hold: a cancelled countdown must not leave the ref
    // armed as "a fill is running" for the next one.
    fillSettledRef.current = true;
    setAutoCloseWaitingForFill(false);
    setAutoCloseSecondsLeft(null);
  }, []);

  /**
   * Close this tab, now.
   *
   * `window.close()` is the real thing — this page was opened with
   * `chrome.tabs.create`, so the browser lets it close itself. But a close that
   * is silently ignored would look exactly like the feature not existing and
   * would leave the tab sitting there forever, so the fallback timer is armed
   * FIRST: if the close works, the page is torn down and the timer never runs.
   */
  const closeEditorTab = useCallback(() => {
    cancelAutoClose();
    window.setTimeout(() => {
      void sendToBackground<{ closed: number }>({
        type: 'CLOSE_EDITOR_TAB',
        requestId: createRequestId('close'),
        // The session id, never a tab id: the background finds the tab by URL,
        // so this can only ever close an editor belonging to THIS session.
        payload: { sessionId: sessionId ?? '' },
      }).catch(() => undefined);
    }, AUTO_CLOSE_FALLBACK_MS);
    window.close();
  }, [cancelAutoClose, sessionId]);

  /** Apply one countdown tick. Driven by the interval and by `noteFillSettled`. */
  const runAutoCloseStep = useCallback(() => {
    const step = autoCloseStep({
      deadline: autoCloseDeadlineRef.current,
      now: Date.now(),
      fillSettled: fillSettledRef.current,
    });

    if (step.phase === 'close') {
      closeEditorTab();
      return;
    }
    if (step.phase === 'idle') {
      setAutoCloseWaitingForFill(false);
      setAutoCloseSecondsLeft(null);
      return;
    }
    if (step.phase === 'waiting-for-fill') {
      setAutoCloseWaitingForFill(true);
      setAutoCloseSecondsLeft(0);
      return;
    }
    setAutoCloseWaitingForFill(false);
    setAutoCloseSecondsLeft(step.secondsLeft);
  }, [closeEditorTab]);

  /**
   * Start the "close this editor" countdown.
   *
   * The deadline is counted from the CLICK, because that is the wait the button
   * promises. It is a floor, not a fixed delay: a fill takes 5–25 s on the real
   * page, and the close is held off until the fill has reported back (see
   * `auto-close.ts`). The tab used to disappear mid-fill — the countdown expired
   * while the worker was still deleting and uploading, so the seller lost the
   * page and only ever saw the outcome on the toolbar badge.
   */
  const startAutoClose = useCallback(() => {
    cancelAutoClose();
    fillSettledRef.current = false;
    autoCloseDeadlineRef.current = Date.now() + FILL_AUTO_CLOSE_MS;
    setAutoCloseWaitingForFill(false);
    setAutoCloseSecondsLeft(Math.ceil(FILL_AUTO_CLOSE_MS / 1000));

    // Ticks faster than once a second so the label never skips a number while
    // the tab is in the foreground. The deadline above decides when to close.
    autoCloseTimerRef.current = window.setInterval(runAutoCloseStep, 250);
  }, [cancelAutoClose, runAutoCloseStep]);

  /**
   * The fill has reported back, so this tab may now close.
   *
   * Re-evaluated immediately rather than on the next tick: a slow fill outlives
   * the deadline, and making the user wait up to 250 ms more after it finally
   * finishes would look like the close had been forgotten.
   */
  const noteFillSettled = useCallback(() => {
    fillSettledRef.current = true;
    runAutoCloseStep();
  }, [runAutoCloseStep]);

  // The watermark is deliberately kept out of the layer document so UNDO / REDO
  // / CLEAR can never remove it (see use-watermark.ts).
  const watermark = useWatermark();

  const stageHandleRef = useRef<EditorStageHandle | null>(null);
  const hydratedRef = useRef(false);

  // ---- remembered text style
  //
  // A preference, not document state: it never enters the history stack, and
  // loading it dispatches nothing, so hydrating still yields exactly one
  // history entry.
  //
  // Refs rather than state on purpose — nothing renders from the remembered
  // style (it is only read when a text layer is created), and reacting to it
  // with state would re-render the whole stage on every field blur.
  const textStyleRef = useRef<TextStyleDefaults>({ ...DEFAULT_TEXT_STYLE });
  const textStyleTouchedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void loadTextDefaults().then((loaded) => {
      // A style the user already changed always beats the stored one.
      if (cancelled || textStyleTouchedRef.current) return;
      textStyleRef.current = loaded;
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Remember a style change. Fire-and-forget on purpose: this runs on every
   * field blur, and blocking the commit on a storage round-trip would make the
   * panel feel sticky for no benefit.
   */
  const rememberTextStyle = useCallback((style: Partial<TextStyleDefaults>) => {
    const next = { ...textStyleRef.current, ...style };
    textStyleTouchedRef.current = true;
    textStyleRef.current = next;
    void saveTextDefaults(next);
  }, []);

  const document = state.history.present;

  /** Non-null only while the current selection is a text layer. */
  const selectedTextLayer = useMemo(() => {
    const layer = findLayer(document, state.selectedLayerId);
    return layer?.kind === 'text' ? layer : null;
  }, [document, state.selectedLayerId]);

  // ---- hydrate the persisted composition once the session is ready
  useEffect(() => {
    if (loading || fatalError || hydratedRef.current) return;
    hydratedRef.current = true;
    dispatch({ type: 'LOAD_DOCUMENT', document: initialDocument });
  }, [loading, fatalError, initialDocument]);

  // ---- persist the composition (small JSON, chrome.storage.local is fine)
  useEffect(() => {
    if (!sessionId || !hydratedRef.current) return;
    const key = `aiee:doc:${sessionId}`;
    void chrome.storage.local.set({ [key]: document });
  }, [document, sessionId]);

  const materialUrlById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const material of materials) map[material.id] = material.url;
    return map;
  }, [materials]);

  const materialUrls = useMemo(() => materials.map((material) => material.url), [materials]);
  const images = useImageMap(materialUrls);

  const imageForLayer = useCallback(
    (layer: ImageLayer): HTMLImageElement | undefined => {
      const url = materialUrlById[layer.materialId];
      return url ? images[url] : undefined;
    },
    [images, materialUrlById],
  );

  // ---- editor commands
  const handleAddMaterial = useCallback((material: EditorMaterial) => {
    dispatch({ type: 'ADD_LAYER', layer: createLayerFromMaterial(material) });
  }, []);

  /** Text layers enter through the very same ADD_LAYER path as pictures. */
  const handleAddText = useCallback(() => {
    dispatch({ type: 'ADD_LAYER', layer: createTextLayer(textStyleRef.current) });
  }, []);

  /**
   * Local uploads (picker or clipboard) are persisted into the session record
   * first and only then handed to the cutout queue — that ordering is what makes
   * them survive a refresh.
   *
   * Uploads deliberately do NOT land on the canvas: the material panel is the
   * place where the user decides which picture to compose with.
   */
  const handleUpload = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      try {
        const outcome = await addUploadedImages(files);
        if (!outcome) return;
        showNotice(describeUploadOutcome(outcome));
      } catch (error) {
        // Reached only when persisting the record itself failed.
        showNotice({ kind: 'error', text: `添加图片失败：${messageOf(error)}` });
      }
    },
    [addUploadedImages],
  );

  // Pasting a screenshot is just a second entry point into the same path.
  usePasteImages({
    enabled: !loading && !fatalError,
    onPaste: (files) => void handleUpload(files),
  });

  /**
   * Committed once per finished edit (blur, or a discrete click) so a single
   * change produces exactly one undo step.
   */
  const handleCommitText = useCallback(
    (layerId: string, patch: LayerPatch) => {
      dispatch({ type: 'COMMIT_LAYER', layerId, patch });
      // Only style edits are remembered — `pickTextStyle` returns null for a
      // patch that is purely copy / position / transform.
      const style = pickTextStyle(patch);
      if (style) rememberTextStyle(style);
    },
    [rememberTextStyle],
  );

  /** Back to the factory style: the current layer *and* the stored preference. */
  const handleResetTextStyle = useCallback((layerId: string) => {
    dispatch({ type: 'COMMIT_LAYER', layerId, patch: { ...DEFAULT_TEXT_STYLE } });
    textStyleTouchedRef.current = true;
    textStyleRef.current = { ...DEFAULT_TEXT_STYLE };
    void clearTextDefaults();
  }, []);

  const handleSelect = useCallback((layerId: string | null) => {
    dispatch({ type: 'SELECT_LAYER', layerId });
  }, []);

  const handleDragEnd = useCallback((layerId: string, x: number, y: number) => {
    dispatch({ type: 'COMMIT_LAYER', layerId, patch: { x, y } });
  }, []);

  const handleTransformEnd = useCallback((layerId: string, patch: LayerPatch) => {
    dispatch({ type: 'COMMIT_LAYER', layerId, patch });
  }, []);

  const handleMoveLayer = useCallback((layerId: string, direction: 'up' | 'down') => {
    dispatch({ type: 'MOVE_LAYER', layerId, direction });
  }, []);

  const handleDeleteLayer = useCallback((layerId: string) => {
    dispatch({ type: 'DELETE_LAYER', layerId });
  }, []);

  const handleUndo = useCallback(() => dispatch({ type: 'UNDO' }), []);
  const handleRedo = useCallback(() => dispatch({ type: 'REDO' }), []);
  const handleClear = useCallback(() => dispatch({ type: 'CLEAR' }), []);
  const handleToggleBackground = useCallback(
    () => dispatch({ type: 'SET_BACKGROUND', showWhite: !state.showWhiteBackground }),
    [state.showWhiteBackground],
  );
  const handleToggleWatermark = useCallback(
    () => watermark.setEnabled(!watermark.enabled),
    [watermark],
  );

  // ---- keyboard shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) handleRedo();
        else handleUndo();
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && state.selectedLayerId) {
        event.preventDefault();
        handleDeleteLayer(state.selectedLayerId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleDeleteLayer, handleRedo, handleUndo, state.selectedLayerId]);

  const handleBack = useCallback(async () => {
    if (sessionId) {
      try {
        const key = `${STORAGE_KEYS.sessionPrefix}${sessionId}`;
        const stored = await chrome.storage.session.get(key);
        const meta = stored?.[key] as EditorSessionMeta | undefined;
        if (meta && typeof meta.sourceTabId === 'number') {
          await chrome.tabs.update(meta.sourceTabId, { active: true });
          return;
        }
      } catch {
        /* fall through */
      }
    }
    window.close();
  }, [sessionId]);

  // ---- export: 800x800, ALWAYS white background PNG
  //
  // Downloading and page-filling need exactly the same PNG, so both go through
  // `composePng`. Duplicating the render would let the two drift apart, and a
  // filled image that differs from the downloaded one is the worst kind of bug
  // to notice: it only shows up on the live product page.
  const composePng = useCallback(async () => {
    const handle = stageHandleRef.current;
    const stage = handle?.getStage();
    if (!handle || !stage) {
      showNotice({ kind: 'error', text: '画布尚未就绪，请稍后再试' });
      return null;
    }

    const blob = await exportStageToPng(stage, {
      previewScale: handle.getPreviewScale(),
      hooks: {
        before: () => handle.setChromeVisible(false),
        after: () => handle.setChromeVisible(true),
      },
    });

    const size = await readBlobSize(blob);
    if (size.width !== CANVAS_SIZE || size.height !== CANVAS_SIZE) {
      throw new AppError(ErrorCode.UNKNOWN, `导出尺寸异常：${size.width}x${size.height}`);
    }

    return { blob, dataUrl: await blobToDataUrl(blob), filename: buildExportFileName() };
  }, [showNotice]);

  const handleExport = useCallback(async () => {
    let composed: Awaited<ReturnType<typeof composePng>> = null;
    dispatch({ type: 'SET_EXPORTING', exporting: true });

    try {
      composed = await composePng();
      if (!composed) return;

      const payload: ExportInput = { dataUrl: composed.dataUrl, filename: composed.filename };
      const response = await sendToBackground<{ downloadId: number; filename: string }>({
        type: 'DOWNLOAD_COMPOSITE',
        requestId: createRequestId('download'),
        payload,
      });
      if (!response?.ok) {
        throw new AppError(ErrorCode.UNKNOWN, response?.error?.message ?? '下载失败');
      }
      showNotice({ kind: 'ok', text: `已下载 ${composed.filename}（800×800 白底 PNG）` });
    } catch (error) {
      // A failed export must never clear the canvas.
      if (composed) {
        try {
          await downloadBlobInPage(composed.blob, composed.filename);
          showNotice({ kind: 'ok', text: `已通过页面下载 ${composed.filename}` });
          return;
        } catch {
          /* fall through to the error notice */
        }
      }
      showNotice({ kind: 'error', text: `导出失败：${messageOf(error)}` });
    } finally {
      dispatch({ type: 'SET_EXPORTING', exporting: false });
    }
  }, [composePng, showNotice]);

  /**
   * Offer the composed PNG to the product page as a NEW slot image.
   *
   * The composed image never swaps a specific slot in place. When
   * `removeFirstImage` is on, the product's current first image is deleted first
   * so that a product using all six slots has somewhere to put the new one —
   * AliExpress shifts the later images forward, so the new image ends up last
   * either way. The size check runs before anything touches the page, because
   * failing after the upload panel has been opened leaves the seller staring at a
   * half-finished dialog; it also runs before the delete, so a too-large PNG can
   * never cost the seller an image.
   */
  const handleFillPage = useCallback(async () => {
    // Armed before anything else can fail, and released in `finally` below. An
    // early return (canvas not ready, an oversized PNG) settles at once, so it
    // still closes on the 10 s mark — while a fill that really runs holds the
    // close off until it is done.
    startAutoClose();
    setFilling(true);
    dispatch({ type: 'SET_EXPORTING', exporting: true });

    try {
      const composed = await composePng();
      if (!composed) return;

      if (composed.blob.size > PAGE_FILL_MAX_BYTES) {
        throw new AppError(
          ErrorCode.UNKNOWN,
          `PNG 体积 ${(composed.blob.size / 1024 / 1024).toFixed(2)} MB，超过速卖通 5 MB 上传上限，请减少图层或缩小素材`,
        );
      }

      const response = await sendToBackground<PageFillResult>({
        type: 'REPLACE_PAGE_IMAGE',
        requestId: createRequestId('fill'),
        payload: {
          sessionId: sessionId ?? '',
          dataUrl: composed.dataUrl,
          filename: composed.filename,
          removeFirstImage,
        },
      });
      if (!response?.ok) {
        throw new AppError(ErrorCode.UNKNOWN, response?.error?.message ?? '回填失败');
      }
      const result = response.data;
      if (!result) throw new AppError(ErrorCode.UNKNOWN, '回填没有返回结果');

      // "Unconfirmed" means the file reached the panel but no server-side
      // completion signal was seen — worth telling the user to check, but not a
      // failure to shout about.
      //
      // A warning takes precedence over both: the run succeeded, but something
      // about it needs a human look (typically "no empty slot, so this may have
      // overwritten an existing image"). Styling it as an error is deliberate —
      // this is the one outcome the user must not skim past.
      const warning = result.warnings[0];
      if (warning) {
        showNotice({ kind: 'error', text: `回填完成，但需确认：${warning}` });
      } else {
        showNotice({
          kind: result.status === 'success' ? 'ok' : 'error',
          text: result.status === 'success' ? `已回填到商品页：${result.message}` : `回填未确认：${result.message}`,
        });
      }
    } catch (error) {
      showNotice({ kind: 'error', text: `回填失败：${messageOf(error)}` });
    } finally {
      setFilling(false);
      dispatch({ type: 'SET_EXPORTING', exporting: false });
      // Releasing the hold only now is the whole point: the product page has
      // stopped being touched, so this tab is finally safe to close.
      noteFillSettled();
    }
  }, [composePng, noteFillSettled, removeFirstImage, sessionId, showNotice, startAutoClose]);

  if (!sessionId) {
    return <FatalScreen title="缺少 session 参数" detail="请从 AliExpress 商品页点击插件图标重新进入。" />;
  }
  if (loading) {
    return <FatalScreen title="正在加载会话…" detail="正在从本地读取原图与抠图结果。" />;
  }
  if (fatalError) {
    return <FatalScreen title="无法打开编辑器" detail={fatalError} />;
  }

  return (
    <div className="editor">
      <Toolbar
        canUndo={canUndo(state.history)}
        canRedo={canRedo(state.history)}
        exporting={state.exporting}
        filling={filling}
        showWhiteBackground={state.showWhiteBackground}
        layerCount={document.layers.length}
        sourceUrl={sessionId}
        watermarkOptions={watermark.options.map((option) => ({ id: option.id, name: option.name }))}
        activeWatermarkId={watermark.activeId}
        watermarkEnabled={watermark.enabled && Boolean(watermark.layer)}
        onBack={() => void handleBack()}
        onAddText={handleAddText}
        onUpload={(files) => void handleUpload(files)}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onToggleBackground={handleToggleBackground}
        onToggleWatermark={handleToggleWatermark}
        onSelectWatermark={watermark.selectWatermark}
        onClear={handleClear}
        onExport={() => void handleExport()}
        removeFirstImage={removeFirstImage}
        onToggleRemoveFirstImage={setRemoveFirstImage}
        onFillPage={() => void handleFillPage()}
      />

      <div className="status-bar">
        <div className="status-bar__progress">
          <span>
            抠图进度：{progress.success + progress.failed}/{progress.total}
          </span>
          <span>成功 {progress.success}</span>
          <span>失败 {progress.failed}</span>
          <span>进行中 {progress.active}</span>
          <span>排队 {progress.waiting}</span>
        </div>
        {/*
          Stays mounted even while empty: a live region has to exist before its
          text changes, otherwise screen readers never announce the update.
          `title` carries the full text, which the ellipsis may cut off.
        */}
        <span
          className={
            notice ? `status-bar__notice status-bar__notice--${notice.kind}` : 'status-bar__notice'
          }
          role="status"
          aria-live="polite"
          title={notice?.text}
        >
          {notice?.text}
        </span>
        {/*
          Kept outside the notice span on purpose: that one is a polite live
          region and would re-announce this every second. `role="timer"` is not a
          live region, which is exactly what a per-second countdown needs.

          Two states, because the close can be on hold: the countdown is only
          real once the fill has reported back, and until then saying "0 秒后关闭"
          would read as a stuck timer.
        */}
        {autoCloseSecondsLeft !== null ? (
          <span className="status-bar__auto-close" role="timer">
            {autoCloseWaitingForFill
              ? '回填完成后将自动关闭编辑器'
              : `将在 ${autoCloseSecondsLeft} 秒后关闭编辑器`}
            <button type="button" onClick={cancelAutoClose}>
              取消
            </button>
          </span>
        ) : null}
      </div>

      {/*
        Kept as its own box rather than folded into the status bar: this one
        means "your configuration is broken", not "the last action finished".
      */}
      {watermark.error ? (
        <div className="notice notice--error">水印框加载失败：{watermark.error}</div>
      ) : null}

      <div className="editor__body">
        <MaterialPanel
          materials={materials}
          statusByImageId={statusByImageId}
          onAdd={handleAddMaterial}
          onRetry={retryCutout}
        />

        <div className={`canvas-panel${state.showWhiteBackground ? ' canvas-panel--white' : ''}`}>
          <EditorStage
            layers={document.layers}
            imageForLayer={imageForLayer}
            watermark={watermark.layer}
            watermarkImage={watermark.image}
            selectedLayerId={state.selectedLayerId}
            onSelect={handleSelect}
            onDragEnd={handleDragEnd}
            onTransformEnd={handleTransformEnd}
            handleRef={stageHandleRef}
          />
        </div>

        <LayerPanel
          layers={document.layers}
          watermark={
            watermark.layer ? { name: watermark.meta?.name ?? '默认水印' } : null
          }
          selectedLayerId={state.selectedLayerId}
          selectedTextLayer={selectedTextLayer}
          onSelect={handleSelect}
          onMove={handleMoveLayer}
          onDelete={handleDeleteLayer}
          onMoveEnd={() => undefined}
          onCommitText={handleCommitText}
          onResetTextStyle={handleResetTextStyle}
        />
      </div>
    </div>
  );
}

function FatalScreen({ title, detail }: { title: string; detail: string }): JSX.Element {
  return (
    <div className="editor">
      <div className="options">
        <h1>{title}</h1>
        <p className="hint">{detail}</p>
      </div>
    </div>
  );
}
