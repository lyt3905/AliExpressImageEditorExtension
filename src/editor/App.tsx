import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  AUTO_CLOSE_FALLBACK_MS,
  AUTO_COMPOSE_GIVE_UP_MS,
  AUTO_COMPOSE_GRACE_MS,
  CANVAS_SIZE,
  FILL_AUTO_CLOSE_MS,
  PAGE_FILL_MAX_BYTES,
  STORAGE_KEYS,
} from '../shared/constants';
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
import { loadCodePlacement, saveCodePlacement, type CodePlacement } from '../services/code-placement';
import {
  defaultLogoPlacement,
  loadLogoPlacements,
  saveLogoPlacement,
  type LogoPlacementMap,
} from '../services/logo-placement';
import { listBrands, loadBrandLogo, matchBrandByTitleDetailed } from '../services/brand-store';
import { syncBrandCatalog } from '../services/brand-catalog/sync';
import { claimSilentSyncAttempt } from '../services/brand-catalog/silent-sync';
import { putBlob, getBlob } from '../services/indexed-db';
import type { BrandMeta } from '../shared/types';
import { describeUploadOutcome } from '../services/upload-images';
import { createAlphaProbeCache } from '../services/composition/alpha-probe';
import {
  bindMaterialRoles,
  pickSecondary,
  selectSupportMaterials,
  type SupportSlotRequest,
} from '../services/composition/bind-materials';
import {
  bindMaterialsWithVision,
  selectVisionCandidates,
  type VisionBinding,
} from '../services/composition/vision-binder';
import { blobToThumbnailDataUrl } from '../services/image-thumbnail';
import {
  bindingKeyFor,
  createComposeCache,
  imageIdentity,
  resultKeyFor,
  type CachedBinding,
} from '../services/compose-cache';
import { loadSettings } from '../services/settings';
import { resolveVisionConfigs } from '../services/vision-endpoints';
import {
  buildCompositionPlan,
  type CompositionPlan,
  type PlannerMaterial,
} from '../services/composition/planner';
import type { LayoutTemplate } from '../services/composition/types';
import {
  DEFAULT_TEMPLATE_KEY,
  listTemplateKeys,
  parseTemplateByKey,
} from '../services/composition/templates';
import { measureTextWithCanvas } from '../services/text-measure';
import { ComposePanel } from './components/ComposePanel';
import { carriedLayers, planToLayers } from './state/compose-emit';
import { EditorStage, type EditorStageHandle } from './components/EditorStage';
import { LayerPanel } from './components/LayerPanel';
import { MaterialPanel } from './components/MaterialPanel';
import { Toolbar } from './components/Toolbar';
import { autoCloseStep } from './state/auto-close';
import { autoComposeStep, countForeignLayers } from './state/auto-compose';
import {
  createEditorState,
  createLayerFromMaterial,
  createProductCodeTextLayer,
  createTextLayer,
  editorReducer,
  findLayer,
} from './state/editor-reducer';
import { canRedo, canUndo } from './state/history';
import { rotationCommit, transformPatch, type TransformCommand } from './state/transform';
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

/**
 * Turn a cached vision answer back into material ids of THIS session.
 *
 * The cache stores source-image identities because material ids die with the
 * session. Returning null means "some picture it named is gone", which is the
 * same as a miss: a hero we cannot point at is worse than asking the model again.
 */
function resolveCachedBinding(
  cached: CachedBinding,
  identityByMaterialId: ReadonlyMap<string, string>,
): VisionBinding | null {
  const materialFor = (identity: string | null): string | null => {
    if (!identity) return null;
    for (const [materialId, candidate] of identityByMaterialId) {
      if (candidate === identity) return materialId;
    }
    return null;
  };
  const heroId = materialFor(cached.hero);
  if (!heroId) return null;
  const slotMaterialIds: Record<string, string> = {};
  for (const [slotId, identity] of Object.entries(cached.slots ?? {})) {
    const materialId = materialFor(identity);
    // A slot we cannot point at simply stays empty: the planner warns, and the
    // rest of the collage still lands. Never substitute a different photo here.
    if (materialId) slotMaterialIds[slotId] = materialId;
  }
  return {
    heroId,
    boxId: materialFor(cached.box),
    slotMaterialIds,
    // Sizes are per SLOT, not per photo, so they survive the identity remap as-is.
    fills: cached.fills ?? {},
    /*
      Frame-watermark photos: a cached identity that no longer resolves is dropped,
      not remembered as "unknown". The list only ever means "these specific photos",
      and this session has none of them — so nothing is excluded on its account.
    */
    skippedIds: (cached.skipped ?? []).map((identity) => materialFor(identity)).filter((id): id is string => Boolean(id)),
    confidence: cached.confidence,
    reason: cached.reason,
  };
}

/**
 * The template's collage slots: picture slots that are neither the hero nor the
 * package and that say where they want their photo (`closeup`).
 *
 * Order is z, so slot 1 of the answer is the one drawn underneath. A two-slot
 * template returns an empty list and the whole collage path stays switched off.
 */
function supportSlotsOf(template: LayoutTemplate): SupportSlotRequest[] {
  const renderOrder = template.rules.renderOrder;
  const rank = (slotId: string, zIndex: number): number => {
    const index = renderOrder?.indexOf(slotId) ?? -1;
    return index === -1 ? zIndex : index;
  };
  return [...template.slots]
    .filter((slot) => slot.role !== 'hero' && slot.role !== 'box' && slot.closeup !== undefined)
    .sort((left, right) => rank(left.id, left.zIndex) - rank(right.id, right.zIndex))
    .map((slot) => ({
      slotId: slot.id,
      ...(slot.sourceSelection?.expectedClass ? { expectedClass: slot.sourceSelection.expectedClass } : {}),
      ...(slot.sourceSelection?.viewTypes.length ? { viewTypes: slot.sourceSelection.viewTypes } : {}),
      ...(slot.sourceSelection?.framing.length ? { framing: slot.sourceSelection.framing } : {}),
      ...(slot.sourceSelection?.prefer.length ? { prefer: slot.sourceSelection.prefer } : {}),
      ...(slot.sourceSelection?.exclude.length ? { exclude: slot.sourceSelection.exclude } : {}),
    }));
}

export function App(): JSX.Element {
  const sessionId = useMemo(() => new URLSearchParams(window.location.search).get('session'), []);
  const {
    loading,
    fatalError,
    session,
    materials,
    statusByImageId,
    initialDocument,
    progress,
    cachedCutouts,
    retryCutout,
    addUploadedImages,
  } = useEditorSession(sessionId);

  // ---- brand registry (logos are EditorMaterials of a special kind)
  const [brands, setBrands] = useState<BrandMeta[]>([]);
  const [brandMaterials, setBrandMaterials] = useState<EditorMaterial[]>([]);
  const [activeBrandId, setActiveBrandId] = useState<string | null>(null);

  /**
   * Load the brand registry into memory, mapping each logo blob to an
   * `EditorMaterial`. Extracted so the silent sync below can re-run it after it
   * changes the registry — without that, a first-ever visitor would see the list
   * they loaded before the sync landed and have to reload the page.
   */
  const loadBrandMaterials = useCallback(async (): Promise<void> => {
    const list = await listBrands();
    setBrands(list);
    if (list.length === 0) {
      setBrandMaterials([]);
      return;
    }
    const loaded: EditorMaterial[] = [];
    for (const brand of list) {
      const blob = await loadBrandLogo(brand);
      if (!blob) continue;
      // Reuse the shared blob store: brand materials survive like cutouts.
      await putBlob(brand.logoBlobId, blob).catch(() => undefined);
      loaded.push({
        id: `material-brand-${brand.id}`,
        imageId: `brand-${brand.id}`,
        blobId: brand.logoBlobId,
        kind: 'brand',
        width: brand.width,
        height: brand.height,
        url: URL.createObjectURL(blob),
        label: `品牌：${brand.name}`,
      });
    }
    setBrandMaterials(loaded);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      /*
        Sync the catalog first, then **always** read the registry — but never let
        the sync delay the first paint for long. It gets one shot per tab
        (`claimSilentSyncAttempt`); if the catalog is already fresh the 24h TTL
        makes this a single storage read, and if GitHub is unreachable the 15s
        timeout ends in the catch below. Either way the editor renders with
        whatever the local registry already holds.

        Do not turn "the sync added nothing" into an early return. That shortcut
        used to skip `loadBrandMaterials()` whenever the catalog was current —
        which is the normal case — so the brand list stayed empty and the toolbar
        select rendered disabled ("不使用品牌" and nothing to pick). The registry
        is the source of truth here; the sync is only one of the things that can
        change it.
      */
      if (claimSilentSyncAttempt()) {
        try {
          const settings = await loadSettings();
          await syncBrandCatalog(
            settings.brandCatalogUrl ? { extraBaseUrls: [settings.brandCatalogUrl] } : {},
          );
          // Failures are already recorded in `lastError` for the Options page; a
          // background toast for "GitHub unreachable" would only worry the seller.
        } catch {
          /* silent: see comment above */
        }
      }
      if (cancelled) return;
      await loadBrandMaterials();
    })();
    return () => {
      cancelled = true;
    };
  }, [loadBrandMaterials]);

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

  // ---- 智能排版 (template composition)
  const [templateKey, setTemplateKey] = useState<string>(DEFAULT_TEMPLATE_KEY);
  /*
    `heroId` / `boxId` 仍然是排版的两个入参，但**不再有手选入口**（10.18.4 起面板上
    没有主体/包装盒下拉框）：它们由 AI 的答案写入，AI 不可用时由标签启发式与面积兜底
    决定。保留 state 是因为「重新识别素材角色」、缓存命中与自动排版三条路都要共享同一份
    结论，而且成品图缓存键要用它。
  */
  const [heroId, setHeroId] = useState<string | null>(null);
  const [boxId, setBoxId] = useState<string | null>(null);
  const [composeBusy, setComposeBusy] = useState(false);
  const [composePlan, setComposePlan] = useState<CompositionPlan | null>(null);
  const [composeError, setComposeError] = useState<string | null>(null);
  const [visionBusy, setVisionBusy] = useState(false);
  const [bindNote, setBindNote] = useState<string | null>(null);
  /**
   * Collage slots the AI picked: `slotId -> materialId`.
   *
   * Kept beside `heroId`/`boxId` because they come from the same answer. Empty for
   * every two-slot template; a collage uses it so the three photos are three
   * different photos rather than whatever happened to be largest.
   */
  const [visionSlots, setVisionSlots] = useState<Record<string, string>>({});
  /**
   * Model-suggested occupancy per picture slot (`slotId -> 0-1`).
   *
   * Kept next to `visionSlots` because it comes from the same answer and shares its
   * lifetime: a re-bind replaces both, and a cached binding restores both.
   */
  const [visionFills, setVisionFills] = useState<Record<string, number>>({});
  /**
   * Materials the model ruled out: they carry the shop's own frame watermark.
   *
   * The frame is part of the pixels, so cut-out keeps it; putting such a photo into
   * the collage produces a white printed card with a border inside an otherwise
   * clean layout. Exclusion happens here (not in the prompt alone) so that every
   * consumer — heuristic binding, secondary pick, collage slots — sees the same
   * filtered pool and cannot quietly re-admit one.
   */
  const [visionSkipped, setVisionSkipped] = useState<string[]>([]);
  /**
   * The same list, readable synchronously.
   *
   * The automatic run asks the model and composes inside one `await` chain: the
   * `setVisionSkipped` above only lands on the next render, so `composeFor` — already
   * captured from this render — would still hold the unfiltered candidates and drop
   * the framed photo into a collage slot on the very run that detected it. The ref is
   * what makes "skip it" mean "this time", not "next time".
   */
  const visionSkippedRef = useRef<string[]>([]);
  /**
   * Cache key of the composition that is on screen, waiting to be photographed.
   *
   * Set right after a successful compose and consumed by an effect that waits for
   * the pictures to decode — exporting before that yields a PNG with blanks in it.
   */
  const [pendingResultKey, setPendingResultKey] = useState<string | null>(null);
  /** When the composed PNG was last written to the local cache (for the panel). */
  const [resultCachedAt, setResultCachedAt] = useState<number | null>(null);
  /**
   * What the automatic run is doing right now, for the panel's status line.
   *
   * The run spends most of its time waiting for cut-outs, and "正在排版…" only for a
   * second. Without this the panel looked idle for 10+ seconds and the seller had no
   * way to tell whether anything was happening.
   */
  const [autoPhase, setAutoPhase] = useState<'waiting' | 'binding' | 'composing' | 'done'>('waiting');
  /**
   * Whether the current selection was made by the user, and therefore gets drag
   * priority on the canvas (see `state/drag-owner.ts`).
   *
   * A selection the app makes by itself — the hero the planner picks after
   * composing — must not claim gestures: its box covers most of the canvas, so
   * every drag would move it and the layer under the finger would stay put.
   */
  const [selectionIsExplicit, setSelectionIsExplicit] = useState(false);
  /**
   * Alpha scans are per-blob and expensive enough to notice: a 512px decode plus
   * two passes over 262k pixels. Cached for the session, keyed by `blobId` (which
   * is deterministic for cutouts), so re-generating does not re-scan.
   */
  const alphaProbeRef = useRef(createAlphaProbeCache());
  /**
   * Which pending result key we already complained about.
   *
   * 成品图缓存"有时候不写"是最难从界面上看出来的事（画布上一切正常），所以"还没解码完"
   * 这条早退路径要留一条 console 线索 —— 但只留一次，否则每次渲染都刷。
   */
  const decodeWarnedRef = useRef<string | null>(null);

  /** Templates are listed once: the registry is static data. */
  const templateOptions = useMemo(
    () =>
      listTemplateKeys().map((key) => {
        const parsed = parseTemplateByKey(key);
        return {
          key,
          id: parsed.template?.id ?? key,
          version: parsed.template?.version ?? '?',
          status: parsed.template?.status ?? 'draft',
        };
      }),
    [],
  );

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
  /** Remembered placement of the auto-added code layer (see code-placement.ts). */
  const codePlacementRef = useRef<CodePlacement>({ x: 400, y: 48, scale: 1 });
  /** Id of the code layer this session auto-added; commits to it update the memory. */
  const codeLayerIdRef = useRef<string | null>(null);
  /** Per-brand remembered logo placement (see logo-placement.ts). */
  const logoPlacementsRef = useRef<LogoPlacementMap>({});
  /**
   * Layers this editor added by itself (product code, auto brand logo).
   *
   * They must NOT count as "the seller's work": the automatic compose replaces the
   * canvas, and treating its own code layer as existing content made it skip on every
   * product whose title had a code — the panel then said 「已恢复上次的画布，未自动覆盖」
   * and nothing ever appeared.
   */
  const autoAddedLayerIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    void loadTextDefaults().then((loaded) => {
      // A style the user already changed always beats the stored one.
      if (cancelled || textStyleTouchedRef.current) return;
      textStyleRef.current = loaded;
    });
    void loadCodePlacement().then((placement) => {
      if (cancelled) return;
      codePlacementRef.current = placement;
    });
    void loadLogoPlacements().then((placements) => {
      if (cancelled) return;
      logoPlacementsRef.current = placements;
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

    const productCode = session?.productCode;
    const codeAddedKey = sessionId ? `aiee:code-added:${sessionId}` : null;
    const alreadyThere =
      productCode !== undefined &&
      initialDocument.layers.some(
        (layer) => layer.kind === 'text' && layer.text.trim() === productCode,
      );

    const hydrate = async () => {
      // Default-added exactly once per session: without the marker, deleting
      // the code text and refreshing would force it back onto the canvas.
      let addedBefore = false;
      if (productCode !== undefined && codeAddedKey && !alreadyThere) {
        try {
          const stored = await chrome.storage.local.get(codeAddedKey);
          addedBefore = Boolean(stored?.[codeAddedKey]);
          if (!addedBefore) void chrome.storage.local.set({ [codeAddedKey]: true });
        } catch {
          /* storage unavailable -> fall back to adding it, best effort */
        }
      }

      const layers = [...initialDocument.layers];
      if (productCode !== undefined && !alreadyThere && !addedBefore) {
        const codeLayer = createProductCodeTextLayer(
          productCode,
          textStyleRef.current,
          codePlacementRef.current,
        );
        codeLayerIdRef.current = codeLayer.id;
        autoAddedLayerIdsRef.current.add(codeLayer.id);
        // Pushed last = top of the z-order, so nothing lands above the code.
        layers.push(codeLayer);
      } else if (productCode !== undefined && alreadyThere) {
        /*
          Restored from a saved document. Move the code back to the top: builds
          before the brand-logo feature could have saved it below a logo, and
          "编号置顶" is meant to hold every time the editor opens, not only on
          the first visit.
        */
        const index = layers.findIndex(
          (layer) => layer.kind === 'text' && layer.text.trim() === productCode,
        );
        const codeLayer = index >= 0 ? layers[index] : undefined;
        if (index >= 0 && index !== layers.length - 1 && codeLayer) {
          layers.splice(index, 1);
          layers.push(codeLayer);
          codeLayerIdRef.current = codeLayer.id;
        autoAddedLayerIdsRef.current.add(codeLayer.id);
        } else if (codeLayer) {
          codeLayerIdRef.current = codeLayer.id;
        autoAddedLayerIdsRef.current.add(codeLayer.id);
        }
      }

      dispatch({ type: 'LOAD_DOCUMENT', document: { layers } });
    };

    void hydrate();
  }, [loading, fatalError, initialDocument, session, sessionId]);

  /**
   * The product-code text layer's id, or null when this session has no code.
   *
   * Only the code's hydrate path needs this now: brand logos are appended to the
   * very top of the stack (they carry `locked` and are painted above everything),
   * so they no longer need a "below the code" anchor.
   */
  const findCodeLayerId = useCallback((): string | null => {
    const code = session?.productCode;
    if (!code) return null;
    return document.layers.find((layer) => layer.kind === 'text' && layer.text.trim() === code)?.id ?? null;
  }, [document, session]);

  /** `material-brand-<brandId>` → `<brandId>`; the placement memory is keyed by it. */
  const brandIdOf = useCallback((materialId: string): string | null => {
    const prefix = 'material-brand-';
    return materialId.startsWith(prefix) ? materialId.slice(prefix.length) : null;
  }, []);

  /**
   * Build a brand-logo layer: locked, and placed where this brand's logo was last
   * left (bottom-right corner the first time).
   *
   * Locked by default on purpose — a logo is a stamp the seller puts on once and
   * expects to stay put; grabbing it by accident while dragging the product out of
   * the way was the annoying part. The layer panel offers the unlock.
   */
  const createLogoLayer = useCallback(
    (material: EditorMaterial): ImageLayer => {
      const base = createLayerFromMaterial(material);
      const brandId = brandIdOf(material.id);
      const remembered = brandId ? logoPlacementsRef.current[brandId] : undefined;
      const placement = remembered ?? defaultLogoPlacement(base.sourceWidth, base.sourceHeight);
      return { ...base, ...placement, locked: true };
    },
    [brandIdOf],
  );

  // ---- brand auto-detect
  //
  // Runs once per session, after the document is hydrated AND the brand logos
  // are loaded (they arrive asynchronously). The title is matched against
  // every brand's keywords (the display name is not a matching term); the logo
  // is appended on top and locked (see `createLogoLayer`).
  const brandAutoAppliedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current || brandAutoAppliedRef.current) return;
    if (brands.length === 0 || brandMaterials.length === 0) return;
    brandAutoAppliedRef.current = true;

    const title = session?.productTitle ?? '';
    if (!title) return;
    const matched = matchBrandByTitleDetailed(brands, title);
    if (!matched) return;
    setActiveBrandId(matched.brand.id);
    /*
      Say which keyword did it. A brand auto-appearing under a title that looks
      unrelated is otherwise indistinguishable from a bug — the seller needs to
      know it was a substring hit on a keyword they can edit.
    */
    showNotice({
      kind: 'ok',
      text: `已按标题识别品牌：${matched.brand.name}（命中关键词「${matched.term}」）`,
    });

    const material = brandMaterials.find(
      (entry) => entry.id === `material-brand-${matched.brand.id}`,
    );
    if (!material) {
      /*
        标题命中了品牌，但本机没有它的 Logo 图片（目录同步没拉下来，或手工上传的
        那张丢了）。以前这里静默 return：下拉框显示着品牌名、画布上却没有 Logo，
        看起来像"没从标题里提取"。说清楚，比让人对着一处空白猜要好。
      */
      showNotice({
        kind: 'error',
        text: `已按标题识别品牌：${matched.brand.name}，但本机没有它的 Logo 图片 —— 去选项页「品牌商标」里上传，或点「立即同步」`,
      });
      return;
    }
    const alreadyOnCanvas = document.layers.some(
      (layer) => layer.kind === 'brand' && layer.materialId === material.id,
    );
    if (alreadyOnCanvas) return;
    const logoLayer = createLogoLayer(material);
    autoAddedLayerIdsRef.current.add(logoLayer.id);
    // Appended last = top of the z-order; `EditorStage` keeps brand layers above
    // the album art, the watermark and the code no matter what the stack says.
    dispatch({ type: 'ADD_LAYER', layer: logoLayer });
  }, [brands, brandMaterials, session, document, createLogoLayer, showNotice]);

  // ---- persist the composition (small JSON, chrome.storage.local is fine)
  useEffect(() => {
    if (!sessionId || !hydratedRef.current) return;
    const key = `aiee:doc:${sessionId}`;
    void chrome.storage.local.set({ [key]: document });
  }, [document, sessionId]);

  const materialUrlById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const material of materials) map[material.id] = material.url;
    // Brand logos are canvas-only materials: they render through the same map
    // but never appear in the material panel.
    for (const material of brandMaterials) map[material.id] = material.url;
    return map;
  }, [materials, brandMaterials]);

  const materialUrls = useMemo(
    () => [...materials, ...brandMaterials].map((material) => material.url),
    [materials, brandMaterials],
  );
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

  /**
   * Manual brand pick from the toolbar: adds the logo (once), or removes all
   * logos of other brands when switching. "不使用品牌" removes brand layers.
   */
  const handleSelectBrand = useCallback(
    (brandId: string | null) => {
      setActiveBrandId(brandId);
      // Remove every existing brand layer first: switching brands must not
      // pile two logos onto the canvas.
      for (const layer of document.layers) {
        if (layer.kind === 'brand') dispatch({ type: 'DELETE_LAYER', layerId: layer.id });
      }
      if (!brandId) return;
      const material = brandMaterials.find((entry) => entry.id === `material-brand-${brandId}`);
      if (!material) return;
      // Same path as auto-detect: appended on top, locked, remembered placement.
      const logoLayer = createLogoLayer(material);
      autoAddedLayerIdsRef.current.add(logoLayer.id);
      dispatch({ type: 'ADD_LAYER', layer: logoLayer });
    },
    [brandMaterials, createLogoLayer, document],
  );

  /** Text layers enter through the very same ADD_LAYER path as pictures. */
  const handleAddText = useCallback(() => {
    dispatch({ type: 'ADD_LAYER', layer: createTextLayer(textStyleRef.current) });
  }, []);

  // ---- 智能排版
  //
  // The pipeline is deliberately all-or-nothing: probe every material, solve the
  // layout, and only then touch the document. A failure halfway through must not
  // leave the canvas half-replaced.
  const cutouts = useMemo(
    () => materials.filter((material) => material.kind === 'cutout'),
    [materials],
  );

  /**
   * Cut-outs that may be used for LAYOUT — everything except the photos the model
   * flagged as carrying the shop's frame watermark.
   *
   * `composeFor` still looks the hero/box up in `cutouts`, so a seller who picks a
   * framed photo by hand still gets it: the exclusion is about what the automatic
   * paths may choose, not about hiding material from its owner.
   */
  const usableCutouts = useMemo(
    () => (visionSkipped.length === 0 ? cutouts : cutouts.filter((material) => !visionSkipped.includes(material.id))),
    [cutouts, visionSkipped],
  );

  const bindCandidates = useMemo(
    () =>
      usableCutouts.map((material) => ({
        materialId: material.id,
        label: material.label,
        width: material.width,
        height: material.height,
      })),
    [usableCutouts],
  );

  /**
   * Cross-session cache of the expensive steps (see `services/compose-cache.ts`).
   *
   * Created once: it holds no per-session state of its own, everything is keyed
   * by source-image identity so yesterday's work keeps serving today's session.
   */
  const composeCache = useMemo(() => createComposeCache(), []);

  /** Identity of every session image, keyed by image id. */
  const identityByImageId = useMemo(() => {
    const map = new Map<string, string>();
    for (const image of session?.images ?? []) {
      map.set(
        image.id,
        imageIdentity({
          url: image.url,
          label: image.label,
          width: image.width,
          height: image.height,
          bytes: image.bytes,
          blobId: image.blobId,
        }),
      );
    }
    return map;
  }, [session]);

  /** Cut-out material id -> the identity of the photo it came from. */
  const identityByMaterialId = useMemo(() => {
    const map = new Map<string, string>();
    for (const material of cutouts) {
      const identity = identityByImageId.get(material.imageId);
      if (identity) map.set(material.id, identity);
    }
    return map;
  }, [cutouts, identityByImageId]);

  /**
   * Cache key for the composed PNG of one (hero, box) pair, or null when the
   * materials cannot be identified — then there is nothing to key a cache on.
   *
   * The key covers what ends up in the picture: the hero photo, the packaging
   * photo, the template and the listing. It deliberately does NOT cover the whole
   * cut-out set — the other photos are not in the PNG, and including them meant a
   * single failed cut-out (or one extra photo) threw away yesterday's result.
   */
  const resultKeyForCompose = useCallback(
    (heroMaterialId: string | null, boxMaterialId: string | null): string | null => {
      const heroIdentity = heroMaterialId ? identityByMaterialId.get(heroMaterialId) ?? null : null;
      if (!heroIdentity) return null;
      const boxIdentity = boxMaterialId ? identityByMaterialId.get(boxMaterialId) ?? null : null;
      return resultKeyFor({
        productCode: session?.productCode ?? null,
        templateKey,
        heroIdentity,
        boxIdentity,
      });
    },
    [identityByMaterialId, session, templateKey],
  );

  /**
   * Guess hero/box once, and re-guess only when the current choice disappeared.
   *
   * Overwriting a valid choice on every material update would fight the user: a
   * cutout finishing in the background would silently reset the panel's selects.
   */
  useEffect(() => {
    if (cutouts.length === 0) {
      if (heroId !== null) {
        setHeroId(null);
        setBoxId(null);
      }
      return;
    }
    const ids = new Set(cutouts.map((material) => material.id));
    if (heroId && ids.has(heroId)) return;
    const bound = bindMaterialRoles(bindCandidates);
    setHeroId(bound.heroId);
    setBoxId(bound.boxId);
  }, [bindCandidates, cutouts, heroId]);

  const profileFor = useCallback(async (material: EditorMaterial) => {
    const blob = await getBlob(material.blobId);
    if (!blob) {
      throw new AppError(
        ErrorCode.DOWNLOAD_EMPTY,
        `素材「${material.label}」的图片数据已丢失，请重新抠图后再试`,
      );
    }
    return alphaProbeRef.current.probe(material.blobId, blob);
  }, []);

  /**
   * Build a plan for one (hero, box) pair — probes, fallbacks and solving included.
   *
   * Shared by the manual button and the automatic run, so both obey exactly the same
   * rules; the only difference is where the material ids come from.
   */
  const composeFor = useCallback(
    async (heroMaterialId: string | null, boxMaterialId: string | null): Promise<CompositionPlan | null> => {
      if (!heroMaterialId) {
        setComposeError('未选择主体素材');
        return null;
      }

      const parsed = parseTemplateByKey(templateKey);
      if (!parsed.template) {
        setComposeError(
          `模板校验失败：${parsed.issues.map((issue) => `${issue.path || '<root>'} ${issue.message}`).join('；')}`,
        );
        return null;
      }

      const heroMaterial = cutouts.find((material) => material.id === heroMaterialId);
      if (!heroMaterial) {
        setComposeError('找不到主体素材');
        return null;
      }
      const boxMaterial = boxMaterialId
        ? cutouts.find((material) => material.id === boxMaterialId) ?? null
        : null;

      const heroProfile = await profileFor(heroMaterial);
      const boxProfile = boxMaterial ? await profileFor(boxMaterial) : null;
      /*
        Candidates for the automatic picks (stand-in photo, collage slots). Filtered
        through the ref as well as the state-backed list — see the comment on
        `visionSkippedRef`: within one automatic run the state update is not in this
        closure yet, and a framed photo in a collage slot is exactly the case this
        exclusion exists for.
      */
      const skippedNow = visionSkippedRef.current;
      const layoutCandidates =
        skippedNow.length === 0
          ? bindCandidates
          : bindCandidates.filter((candidate) => !skippedNow.includes(candidate.materialId));
      // Only look for a stand-in photo when there is no package material: the
      // fallback ladder lives in the template, so the panel does not decide it.
      const secondaryCandidate = boxMaterial
        ? null
        : pickSecondary(layoutCandidates, [heroMaterialId, boxMaterialId]);
      const secondaryMaterial = secondaryCandidate
        ? cutouts.find((material) => material.id === secondaryCandidate.materialId) ?? null
        : null;
      const secondaryProfile = secondaryMaterial ? await profileFor(secondaryMaterial) : null;

      /*
        Collage slots: the template may want more photos than hero + package.

        Which photo lands in「背面」is a judgement, so the AI's picks win and the
        rest is filled by area (see `selectSupportMaterials`). Whatever is left over
        is simply not placed — a missing slot is a red reason line, not a broken
        layout, and never a duplicate photo.
      */
      const supportSlots = supportSlotsOf(parsed.template);
      const supports: Array<{ slotId: string; material: PlannerMaterial }> = [];
      if (supportSlots.length > 0) {
        const assignments = selectSupportMaterials({
          slots: supportSlots,
          candidates: layoutCandidates,
          usedIds: [heroMaterialId, boxMaterialId],
          preference: visionSlots,
        });
        for (const assignment of assignments) {
          const material = cutouts.find((entry) => entry.id === assignment.materialId);
          if (!material) continue;
          supports.push({
            slotId: assignment.slotId,
            material: {
              materialId: material.id,
              blobId: material.blobId,
              kind: 'cutout',
              profile: await profileFor(material),
              label: material.label,
            },
          });
        }
      }

      const plan = buildCompositionPlan({
        template: parsed.template,
        hero: {
          materialId: heroMaterial.id,
          blobId: heroMaterial.blobId,
          kind: 'cutout',
          profile: heroProfile,
          label: heroMaterial.label,
        },
        box:
          boxMaterial && boxProfile
            ? {
                materialId: boxMaterial.id,
                blobId: boxMaterial.blobId,
                kind: 'cutout',
                profile: boxProfile,
                label: boxMaterial.label,
              }
            : null,
        secondary:
          secondaryMaterial && secondaryProfile
            ? {
                materialId: secondaryMaterial.id,
                blobId: secondaryMaterial.blobId,
                kind: 'cutout',
                profile: secondaryProfile,
                label: secondaryMaterial.label,
              }
            : null,
        modelCode: session?.productCode ?? null,
        measure: measureTextWithCanvas(),
        seed: session?.productCode ?? sessionId ?? '',
        ...(supports.length > 0 ? { supports } : {}),
        ...(Object.keys(visionFills).length > 0 ? { fills: visionFills } : {}),
      });

      /*
        底线：模板要求的图片张数（`rules.collage.min_pictures`，拼贴模板是 2）。

        素材只够一张时，硬拼出来的"独苗"最坏 —— 画布上一个人站着、四周全白，卖家会
        把它当成品上架。宁可不画，把原因写在红色提示里。
      */
      const minPictures = parsed.template.rules.minPictures ?? 1;
      if (plan.images.length < minPictures) {
        const reason =
          plan.warnings.find((entry) => entry.code === 'not_enough_pictures')?.message ??
          `这个版面至少要 ${minPictures} 张图，当前只有 ${plan.images.length} 张`;
        setComposeError(reason);
        return null;
      }
      return plan;
    },
    [bindCandidates, cutouts, profileFor, session, sessionId, templateKey, visionFills, visionSlots],
  );

  /** One dispatch = one history entry, so a single Ctrl+Z restores the canvas. */
  const applyComposedPlan = useCallback((plan: CompositionPlan) => {
    const planLayers = planToLayers(plan);
    /*
      Brand logos and the product-code text survive the replacement, like the
      watermark does — see `carriedLayers()` for why the code is only carried when
      the template has no text zone of its own.
    */
    const layers = [...planLayers, ...carriedLayers(plan, document.layers, session?.productCode)];
    /*
      Select the hero on the way in, so the transformer lands on the subject instead
      of on nothing or on the backdrop plate — with nothing selected, the first drag
      grabs whatever is underneath and reads as "拖不动".

      This selection is marked as automatic: it must NOT give the hero drag priority.
      Right after composing, the hero's box covers most of the canvas, so a priority
      selection would take over the first gesture no matter what the user pressed
      (that is the 10.3.4 complaint). Priority is earned by selecting by hand.
    */
    const hero = [...planLayers]
      .reverse()
      .find((layer) => layer.kind !== 'text' && layer.kind !== 'plate');
    dispatch({ type: 'APPLY_PLAN', layers, selectLayerId: hero?.id ?? null });
    setSelectionIsExplicit(false);
    setComposePlan(plan);
  }, [document, session]);

  /**
   * Ask the model which material is the hero and which is the packaging.
   *
   * Throws on transport/auth problems and returns null when the answer names no
   * usable hero — the caller decides whether to fall back to labels (manual run:
   * keep them and carry on; 「重新识别素材角色」: say so).
   *
   * The answer is a pure function of (these photos, this model), so it is cached:
   * the second visit to a product skips the vision call entirely. `force` is for
   * 「重新识别素材角色」— that link promises a second opinion, so it must really ask.
   */
  const bindVisionRoles = useCallback(
    async (options?: { force?: boolean }): Promise<VisionBinding | null> => {
      if (cutouts.length === 0) return null;
      const settings = await loadSettings();
      const configs = resolveVisionConfigs(settings.vision);
      const bindingKey = bindingKeyFor({
        productCode: session?.productCode ?? null,
        identities: [...identityByMaterialId.values()],
        /*
          The model, not the endpoint: moving to a backup gateway judges the same
          photos, so yesterday's answer still stands. Only the model that produced
          the answer is allowed to invalidate it.
        */
        model: configs[0]?.model ?? '',
      });

      if (!options?.force) {
        const cached = await composeCache.getBinding(bindingKey).catch(() => null);
        const resolved = cached ? resolveCachedBinding(cached, identityByMaterialId) : null;
        if (resolved) {
          setVisionSlots(resolved.slotMaterialIds);
          setVisionFills(resolved.fills);
          visionSkippedRef.current = resolved.skippedIds;
          setVisionSkipped(resolved.skippedIds);
          return resolved;
        }
      }

      const candidates: Array<{ materialId: string; label: string; dataUrl: string }> = [];
      // Selection happens BEFORE decoding: picking the six worth sending is cheap
      // (labels only), and thumbnailing a dropped material would be wasted work.
      for (const material of selectVisionCandidates(cutouts)) {
        const blob = await getBlob(material.blobId);
        if (!blob) continue;
        candidates.push({
          materialId: material.id,
          label: material.label,
          dataUrl: await blobToThumbnailDataUrl(blob),
        });
      }
      if (candidates.length === 0) return null;

      // The collage slots of the CURRENT template. Asking for them in the same
      // request is what makes「背面 / 正面 / 动作」possible at all — no label or
      // aspect ratio tells a rear shot from a front one.
      const parsedTemplate = parseTemplateByKey(templateKey).template;
      const slots = parsedTemplate ? supportSlotsOf(parsedTemplate) : [];
      const heroSlotId = parsedTemplate?.slots.find((slot) => slot.role === 'hero')?.id;

      const binding = await bindMaterialsWithVision({
        configs,
        candidates,
        ...(slots.length > 0 ? { slots } : {}),
        ...(heroSlotId ? { heroSlotId } : {}),
      });
      if (!binding) return null;
      setVisionSlots(binding.slotMaterialIds);
      setVisionFills(binding.fills);
      visionSkippedRef.current = binding.skippedIds;
      setVisionSkipped(binding.skippedIds);
      const heroIdentity = binding.heroId ? identityByMaterialId.get(binding.heroId) ?? '' : '';
      const slotIdentities: Record<string, string> = {};
      for (const [slotId, materialId] of Object.entries(binding.slotMaterialIds)) {
        const identity = identityByMaterialId.get(materialId);
        if (identity) slotIdentities[slotId] = identity;
      }
      const skippedIdentities = binding.skippedIds
        .map((materialId) => identityByMaterialId.get(materialId))
        .filter((identity): identity is string => Boolean(identity));
      // Stored as identities, so the next session can point at its own materials.
      void composeCache
        .putBinding(bindingKey, {
          hero: heroIdentity,
          box: binding.boxId ? identityByMaterialId.get(binding.boxId) ?? null : null,
          ...(Object.keys(slotIdentities).length > 0 ? { slots: slotIdentities } : {}),
          ...(Object.keys(binding.fills).length > 0 ? { fills: binding.fills } : {}),
          ...(skippedIdentities.length > 0 ? { skipped: skippedIdentities } : {}),
          confidence: binding.confidence,
          reason: binding.reason,
        })
        .catch(() => undefined);
      return binding;
    },
    [composeCache, cutouts, identityByMaterialId, session, templateKey],
  );

  /**
   * 一次点击 = 识别 + 排版。
   *
   * 以前这是两个按钮（「AI 识别素材角色」→「生成主图」）。两个按钮等于把实现细节
   * 漏到了界面上：识别结论只是排版的一个入参，用户凭什么要先点一次再点一次？
   * 顺序点反了还会白排一版。现在识别在内部完成：有缓存结论就直接用（第二次打开
   * 不会真的问模型），没有就当场问。
   *
   * `forceVision` 是按钮下面那条小链接用的：「重新识别素材角色」要真的再问一次，
   * 否则它点下去跟没点一样（缓存命中的速度会让人以为按钮坏了）。
   */
  const handleCompose = useCallback(
    async (options?: { forceVision?: boolean }): Promise<void> => {
      setComposeBusy(true);
      setComposeError(null);
      // 识别结论要当场用上：state 要等下一次渲染，这次排版还在闭包里。
      let hero = heroId;
      let box = boxId;
      /*
        面板上不再有主体/包装盒的下拉框 —— 素材角色由 AI 认，认不出来才回落到标签
        启发式与面积兜底（`bindVisionRoles` / `composeFor` 各自都有一层）。所以这里
        没有"手工优先"分支：识别能跑就跑，跑不动才沿用上一次的 state。
      */
      const identify = cutouts.length > 0;
      try {
        if (identify) {
          setVisionBusy(true);
          try {
            const binding = await bindVisionRoles({ force: options?.forceVision });
            if (binding) {
              hero = binding.heroId;
              box = binding.boxId;
              setHeroId(binding.heroId);
              setBoxId(binding.boxId);
              setBindNote(
                `AI：${binding.reason}（置信度 ${Math.round(binding.confidence * 100)}%）${
                  binding.boxId ? '' : ' · 未识别到包装盒'
                }${
                  binding.skippedIds.length > 0
                    ? ` · 已跳过 ${binding.skippedIds.length} 张带店铺边框水印`
                    : ''
                }`,
              );
            } else if (options?.forceVision) {
              setBindNote('AI 没有给出可用结论，已用标签匹配结果');
            }
          } catch (error) {
            setBindNote(`AI 识别不可用：${messageOf(error)}。已用标签匹配结果`);
          } finally {
            setVisionBusy(false);
          }
        }

        /*
          没有下拉框了，所以"主体是谁"不能停在 null 上（那只会得到一句
          「未选择主体素材」，而用户已经没有别的办法指定）。AI 没给结论时用标签启发式
          兜最后一次，它的答案和自动排版用的是同一套规则。
        */
        if (!hero) {
          const fallback = bindMaterialRoles(bindCandidates);
          if (fallback.heroId) {
            hero = fallback.heroId;
            box = fallback.boxId;
            setHeroId(fallback.heroId);
            setBoxId(fallback.boxId);
          }
        }

        const plan = await composeFor(hero, box);
        if (!plan) return;
        applyComposedPlan(plan);
        setPendingResultKey(resultKeyForCompose(hero, box));

        const firstWarning = plan.warnings[0];
        showNotice(
          firstWarning
            ? { kind: 'error', text: `已排版，但有让步：${firstWarning.message}` }
            : { kind: 'ok', text: '已按模板排版（Ctrl+Z 可整体撤销）' },
        );
      } catch (error) {
        const message = messageOf(error);
        setComposeError(message);
        showNotice({ kind: 'error', text: `排版失败：${message}` });
      } finally {
        setComposeBusy(false);
      }
    },
    [
      applyComposedPlan,
      bindVisionRoles,
      boxId,
      composeFor,
      cutouts.length,
      heroId,
      resultKeyForCompose,
      showNotice,
    ],
  );

  /** 「重新识别素材角色」：同一个按钮的第二档，强制再问一次模型。 */
  const handleRegenerate = useCallback(() => {
    void handleCompose({ forceVision: true });
  }, [handleCompose]);

  // ---- 自动排版：打开编辑器就出图，不用点
  //
  // The decision itself lives in `auto-compose.ts` (pure, tested): wait for the
  // cut-out queue to settle, never wait forever, never overwrite a restored canvas.
  const autoComposeRef = useRef<'idle' | 'running' | 'done'>('idle');
  const [autoGraceElapsed, setAutoGraceElapsed] = useState(false);
  const [autoGiveUpElapsed, setAutoGiveUpElapsed] = useState(false);
  /**
   * How many layers on the canvas belong to the seller (not to this editor).
   *
   * Read during render so the effect sees the current value, and mirrored into a ref
   * because the async run must re-check it after the AI call without a stale closure.
   */
  const foreignLayerCount = countForeignLayers(document.layers, autoAddedLayerIdsRef.current);
  const foreignLayerCountRef = useRef(0);
  foreignLayerCountRef.current = foreignLayerCount;

  useEffect(() => {
    if (loading || fatalError) return;
    const grace = window.setTimeout(() => setAutoGraceElapsed(true), AUTO_COMPOSE_GRACE_MS);
    const giveUp = window.setTimeout(() => setAutoGiveUpElapsed(true), AUTO_COMPOSE_GIVE_UP_MS);
    return () => {
      window.clearTimeout(grace);
      window.clearTimeout(giveUp);
    };
  }, [loading, fatalError]);

  const runAutoCompose = useCallback(async () => {
    setComposeBusy(true);
    setComposeError(null);

    // Labels first: if the model is unreachable we still have a usable pair, and the
    // auto-bind effect may not have committed its state yet in this tick.
    const heuristic = bindMaterialRoles(bindCandidates);
    let hero = heroId ?? heuristic.heroId;
    let box = heroId ? boxId : heuristic.boxId;

    try {
      setAutoPhase('binding');
      setVisionBusy(true);
      try {
        const binding = await bindVisionRoles();
        if (binding) {
          hero = binding.heroId;
          box = binding.boxId;
          setHeroId(hero);
          setBoxId(box);
          setBindNote(
            `AI：${binding.reason}（置信度 ${Math.round(binding.confidence * 100)}%）${
              binding.boxId ? '' : ' · 未识别到包装盒'
            }`,
          );
        }
      } catch (error) {
        setBindNote(`AI 识别不可用：${messageOf(error)}。已用标签匹配自动排版`);
      } finally {
        setVisionBusy(false);
      }

      // The seller may have started editing while the model was thinking.
      if (foreignLayerCountRef.current > 0) {
        setBindNote('画布已被改动，已取消自动排版');
        return;
      }

      const plan = await composeFor(hero, box);
      if (!plan) return;
      if (foreignLayerCountRef.current > 0) {
        setBindNote('画布已被改动，已取消自动排版');
        return;
      }

      setAutoPhase('composing');
      applyComposedPlan(plan);
      setPendingResultKey(resultKeyForCompose(hero, box));
      const firstWarning = plan.warnings[0];
      showNotice(
        firstWarning
          ? { kind: 'error', text: `已自动排版，但有让步：${firstWarning.message}` }
          : { kind: 'ok', text: '已自动生成主图（Ctrl+Z 可整体撤销）' },
      );
    } catch (error) {
      const message = messageOf(error);
      setComposeError(message);
      showNotice({ kind: 'error', text: `自动排版失败：${message}` });
    } finally {
      autoComposeRef.current = 'done';
      setAutoPhase('done');
      setComposeBusy(false);
    }
  }, [
    applyComposedPlan,
    bindCandidates,
    bindVisionRoles,
    boxId,
    composeFor,
    heroId,
    resultKeyForCompose,
    showNotice,
  ]);

  useEffect(() => {
    if (autoComposeRef.current !== 'idle' || composeBusy) return;

    const step = autoComposeStep({
      hydrated: hydratedRef.current,
      existingLayerCount: foreignLayerCount,
      cutoutCount: cutouts.length,
      active: progress.active,
      waiting: progress.waiting,
      graceElapsed: autoGraceElapsed,
      giveUpElapsed: autoGiveUpElapsed,
      alreadyRan: false,
    });

    /*
      Logged once per decision, not once per render: when the automated run does not
      happen, this is the only place that says WHY. The panel can show the visible
      symptom ("素材就绪" that never turns into an image) but not the reason.
    */
    if (step.phase === 'wait') return;

    if (step.phase === 'skip') {
      autoComposeRef.current = 'done';
      // Stop the progress line too: leaving 「素材就绪，准备排版…」 up while nothing is
      // going to happen is the exact symptom that made this look like a frozen UI.
      setAutoPhase('done');
      console.info('[AIEE] 自动排版跳过：', step.reason, {
        layers: document.layers.length,
        cutouts: cutouts.length,
        active: progress.active,
        waiting: progress.waiting,
      });
      if (step.reason === 'canvas-not-empty') setBindNote('已恢复上次的画布，未自动覆盖');
      if (step.reason === 'no-cutout') {
        setBindNote('等了 150 秒仍没有可用的抠图素材，已停止自动排版（可手动点「生成主图」）');
        showNotice({ kind: 'error', text: '没有可用的抠图素材，已跳过自动排版' });
      }
      return;
    }

    console.info('[AIEE] 自动排版开始：', step.reason, {
      cutouts: cutouts.length,
      active: progress.active,
      waiting: progress.waiting,
    });
    autoComposeRef.current = 'running';
    void runAutoCompose();
  }, [
    autoGiveUpElapsed,
    autoGraceElapsed,
    composeBusy,
    cutouts.length,
    document,
    progress.active,
    progress.waiting,
    runAutoCompose,
    showNotice,
  ]);

  /**
   * One line that answers "程序现在在做什么？".
   *
   * The automatic run is dominated by waiting, so the useful information is the
   * cut-out counters, not a static "正在排版". Kept as plain text (no spinner icon)
   * because a live region announcing "3/6" repeatedly is exactly what a screen
   * reader user needs to hear.
   */
  const composeStatus = useMemo((): string | null => {
    if (autoPhase === 'binding') return 'AI 正在识别素材角色…';
    if (autoPhase === 'composing') return '正在按模板排版…';
    if (autoPhase === 'done') return null;

    const settled = progress.success + progress.failed;
    if (cutouts.length === 0) {
      if (progress.total === 0) return '正在读取商品图…';
      return `等待抠图完成：${settled}/${progress.total}（进行中 ${progress.active}，排队 ${progress.waiting}）`;
    }
    if (progress.active > 0 || progress.waiting > 0) {
      return `等待剩余抠图：${settled}/${progress.total}（进行中 ${progress.active}，排队 ${progress.waiting}）`;
    }
    return '素材就绪，准备排版…';
  }, [autoPhase, cutouts.length, progress]);

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
   * Committed once per finished edit — a blur, a discrete click, or the canvas
   * transformer's release — so a single change produces exactly one undo step.
   *
   * Every committed edit funnels through here, which is what lets a text-layer
   * edit reach the style memory with no special case at either call site: the
   * transformer commits `width` when a side handle is dragged, and
   * `pickTextStyle` then picks that up like any other style edit. A patch that
   * carries no style at all — a move, a picture's resize — returns null and is
   * simply not remembered.
   */
  const handleCommitLayer = useCallback(
    (layerId: string, patch: LayerPatch) => {
      dispatch({ type: 'COMMIT_LAYER', layerId, patch });
      const style = pickTextStyle(patch);
      if (style) rememberTextStyle(style);

      // Moving / resizing the auto-added code layer updates its remembered
      // placement, so the next session's code starts where this one ended.
      if (layerId === codeLayerIdRef.current && (patch.x !== undefined || patch.y !== undefined || patch.scale !== undefined)) {
        const layer = findLayer(document, layerId);
        if (layer) {
          codePlacementRef.current = {
            x: patch.x ?? layer.x,
            y: patch.y ?? layer.y,
            scale: patch.scale ?? layer.scale,
          };
          void saveCodePlacement(codePlacementRef.current);
        }
      }

      // Same for a brand logo: once the seller unlocks it and drags / resizes it
      // somewhere, that spot is remembered for this brand alone.
      const moved = patch.x !== undefined || patch.y !== undefined || patch.scale !== undefined;
      if (moved) {
        const layer = findLayer(document, layerId);
        if (layer && layer.kind === 'brand') {
          const brandId = brandIdOf(layer.materialId);
          if (brandId) {
            const placement = {
              x: patch.x ?? layer.x,
              y: patch.y ?? layer.y,
              scale: patch.scale ?? layer.scale,
            };
            logoPlacementsRef.current[brandId] = placement;
            void saveLogoPlacement(brandId, placement);
          }
        }
      }
    },
    [brandIdOf, document, rememberTextStyle],
  );

  /**
   * Lock / unlock a layer from the layer panel.
   *
   * Unlocking selects the logo, so the transformer lands on it and the very next
   * gesture is the one the seller just asked for; locking the selection away also
   * drops the handles so nothing lingers on a layer that cannot move.
   */
  const handleToggleLock = useCallback(
    (layerId: string) => {
      const layer = findLayer(document, layerId);
      if (!layer || layer.kind === 'text' || layer.kind === 'plate') return;
      const nextLocked = !layer.locked;
      dispatch({ type: 'COMMIT_LAYER', layerId, patch: { locked: nextLocked } });
      if (nextLocked && state.selectedLayerId === layerId) {
        dispatch({ type: 'SELECT_LAYER', layerId: null });
        setSelectionIsExplicit(false);
      } else if (!nextLocked) {
        dispatch({ type: 'SELECT_LAYER', layerId });
        setSelectionIsExplicit(true);
      }
    },
    [document, state.selectedLayerId],
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
    // Picking a layer by hand is what earns it drag priority; deselecting drops it.
    setSelectionIsExplicit(layerId !== null);
  }, []);

  const handleDragEnd = useCallback((layerId: string, x: number, y: number) => {
    dispatch({ type: 'COMMIT_LAYER', layerId, patch: { x, y } });
  }, []);

  /**
   * Live knob drag: painted straight onto the Konva node, exactly like the
   * transformer's own gesture. It deliberately does NOT dispatch — routing the
   * preview through UPDATE_LAYER would leave the previewed document as
   * `history.present`, and the commit below would then push *that* onto the past
   * stack, so undo would restore the angle the user just dialled in.
   */
  const handleRotatePreview = useCallback((layerId: string, rotation: number) => {
    stageHandleRef.current?.setLayerRotation(layerId, rotation);
  }, []);

  /** Pointer release or arrow key — one history step for the whole gesture. */
  const handleRotateCommit = useCallback(
    (layerId: string, rotation: number) => {
      const layer = findLayer(document, layerId);
      if (!layer) return;
      // `rotationCommit` returns null for "already there"; committing that would
      // push an undo step that visibly does nothing.
      const patch = rotationCommit(layer, rotation);
      if (patch) dispatch({ type: 'COMMIT_LAYER', layerId, patch });
    },
    [document],
  );

  const handleTransform = useCallback(
    (layerId: string, command: TransformCommand) => {
      const layer = findLayer(document, layerId);
      if (!layer) return;
      dispatch({ type: 'COMMIT_LAYER', layerId, patch: transformPatch(layer, command) });
    },
    [document],
  );

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
      // No `previewScale` here on purpose: the exporter derives the ratio from the
      // stage's own pixel size. Passing the visual scale made it invert a value that
      // was itself derived from that size, and the extra rounding produced 799x799
      // exports for certain window sizes (see services/exporter.ts).
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

  /**
   * Photograph the composition that is on screen, once, into the local cache.
   *
   * This is what 「避免重复生图」means in practice: the next visit to the same
   * product finds the finished 800×800 PNG, and the panel can say so. The capture
   * waits for every picture layer to decode (`imageForLayer` is the decode map):
   * exporting one frame early writes a PNG full of empty boxes.
   *
   * Failures are silent on purpose — the layout is already on screen, and a cache
   * that cannot be written must never look like a broken 生成主图.
   */
  useEffect(() => {
    if (!pendingResultKey || state.exporting) return;
    const pictures = document.layers.filter(
      (layer): layer is ImageLayer => layer.kind !== 'text' && layer.kind !== 'plate',
    );
    if (pictures.length === 0) return;
    /*
      还没解码完就先等（下一次渲染会重进这里）。但"等着"必须留痕：这条路径以前是完全
      静默的，于是"某个商品怎么都不进缓存"在界面上和"缓存成功"长得一模一样。
    */
    const undecoded = pictures.filter((layer) => imageForLayer(layer) === undefined);
    if (undecoded.length > 0) {
      if (decodeWarnedRef.current !== pendingResultKey) {
        decodeWarnedRef.current = pendingResultKey;
        console.warn(
          '[AIEE] 这次还没有写成品图缓存：有图层没解码完',
          undecoded.map((layer) => ({ id: layer.id, kind: layer.kind, materialId: layer.materialId })),
        );
      }
      return;
    }

    const key = pendingResultKey;
    setPendingResultKey(null);
    void (async () => {
      try {
        const composed = await composePng();
        if (!composed) return;
        await composeCache.putResult(key, composed.blob);
        setResultCachedAt(Date.now());
      } catch (error) {
        /*
          Best effort — but not silent: "some products never cache" is impossible
          to diagnose from a seller's screen otherwise, and this line costs
          nothing when it never fires.
        */
        console.warn('[AIEE] 成品图没写进本地缓存：', error);
      }
    })();
  }, [composeCache, composePng, document.layers, imageForLayer, pendingResultKey, state.exporting]);

  /** Cache key of whatever the panel currently has selected, or null. */
  const currentResultKey = useMemo(
    () => resultKeyForCompose(heroId, boxId),
    [boxId, heroId, resultKeyForCompose],
  );

  /**
   * Whether the current selection already has a finished PNG on disk.
   *
   * Re-read whenever the key or the last write changes, so the panel's number is
   * the truth rather than "we wrote it at some point in this session".
   */
  const [cachedResultAt, setCachedResultAt] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entry = currentResultKey
        ? await composeCache.getResult(currentResultKey).catch(() => null)
        : null;
      if (!cancelled) setCachedResultAt(entry?.at ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [composeCache, currentResultKey, resultCachedAt]);

  /**
   * One line of text about what this session reused, or null when nothing was.
   *
   * `cachedCutouts` counts cut-outs adopted at restore; `cachedResultAt` is a finished
   * PNG already on disk for the current material set. Both are worth stating: without
   * them a fast second visit is indistinguishable from a slow one.
   */
  const cacheNote = useMemo((): string | null => {
    const parts: string[] = [];
    if (cachedCutouts > 0) parts.push(`已复用上次的抠图 ${cachedCutouts} 张`);
    if (cachedResultAt) {
      const time = new Date(cachedResultAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      parts.push(`这套素材的成品图已缓存（${time}）`);
    }
    return parts.length > 0 ? parts.join(' · ') : null;
  }, [cachedCutouts, cachedResultAt]);

  /** Hand out the cached PNG without re-rendering or touching the canvas. */
  const handleDownloadCached = useCallback(async () => {
    if (!currentResultKey) return;
    try {
      const blob = await composeCache.readResultBlob(currentResultKey);
      if (!blob) {
        showNotice({ kind: 'error', text: '缓存里的成品图已不在，重新生成一次即可' });
        setCachedResultAt(null);
        return;
      }
      await downloadBlobInPage(blob, buildExportFileName());
      showNotice({ kind: 'ok', text: '已直接使用本地缓存的成品图（没有重新生成）' });
    } catch (error) {
      showNotice({ kind: 'error', text: `读取缓存失败：${messageOf(error)}` });
    }
  }, [composeCache, currentResultKey, showNotice]);

  const handleClearCache = useCallback(async () => {
    try {
      await composeCache.clear();
      setResultCachedAt(null);
      setCachedResultAt(null);
      showNotice({ kind: 'ok', text: '已清除本地缓存，下次会重新抠图、重新生图' });
    } catch (error) {
      showNotice({ kind: 'error', text: `清除缓存失败：${messageOf(error)}` });
    }
  }, [composeCache, showNotice]);

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
        brandOptions={brands.map((brand) => ({ id: brand.id, name: brand.name }))}
        activeBrandId={activeBrandId}
        onSelectBrand={handleSelectBrand}
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
        <div className="editor__left">
          <ComposePanel
            templates={templateOptions}
            templateKey={templateKey}
            onTemplateChange={setTemplateKey}
            cutouts={cutouts}
            busy={composeBusy}
            plan={composePlan}
            error={composeError}
            onGenerate={() => void handleCompose()}
            onRegenerate={handleRegenerate}
            visionBusy={visionBusy}
            bindNote={bindNote}
            status={composeStatus}
            cacheNote={cacheNote}
            hasCachedResult={cachedResultAt !== null}
            onDownloadCached={() => void handleDownloadCached()}
            onClearCache={() => void handleClearCache()}
          />

          <MaterialPanel
            materials={materials}
            statusByImageId={statusByImageId}
            onAdd={handleAddMaterial}
            onRetry={retryCutout}
          />
        </div>

        <div className={`canvas-panel${state.showWhiteBackground ? ' canvas-panel--white' : ''}`}>
          <EditorStage
            layers={document.layers}
            imageForLayer={imageForLayer}
            watermark={watermark.layer}
            watermarkImage={watermark.image}
            // The product code is painted above the watermark frame.
            foregroundLayerId={findCodeLayerId()}
            selectedLayerId={state.selectedLayerId}
            selectionIsExplicit={selectionIsExplicit}
            onSelect={handleSelect}
            onDragEnd={handleDragEnd}
            onTransformEnd={handleCommitLayer}
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
          onToggleLock={handleToggleLock}
          onMoveEnd={() => undefined}
          onCommitText={handleCommitLayer}
          onResetTextStyle={handleResetTextStyle}
          onTransform={handleTransform}
          onRotatePreview={handleRotatePreview}
          onRotateCommit={handleRotateCommit}
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
