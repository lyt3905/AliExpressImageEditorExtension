import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { CANVAS_SIZE, STORAGE_KEYS } from '../shared/constants';
import { AppError, ErrorCode, messageOf } from '../shared/errors';
import { createRequestId, sendToBackground } from '../shared/messages';
import type { EditorLayer, EditorMaterial, EditorSessionMeta, ExportInput } from '../shared/types';
import { downloadBlobInPage } from '../services/downloader';
import { blobToDataUrl, buildExportFileName, exportStageToPng } from '../services/exporter';
import { readBlobSize } from '../services/image-size';
import { EditorStage, type EditorStageHandle } from './components/EditorStage';
import { LayerPanel } from './components/LayerPanel';
import { MaterialPanel } from './components/MaterialPanel';
import { Toolbar } from './components/Toolbar';
import {
  createEditorState,
  createLayerFromMaterial,
  editorReducer,
} from './state/editor-reducer';
import { canRedo, canUndo } from './state/history';
import { useEditorSession } from './state/use-editor-session';
import { useImageMap } from './state/use-image-map';

interface Notice {
  kind: 'ok' | 'error';
  text: string;
}

export function App(): JSX.Element {
  const sessionId = useMemo(() => new URLSearchParams(window.location.search).get('session'), []);
  const { loading, fatalError, materials, statusByImageId, initialDocument, progress, retryCutout } =
    useEditorSession(sessionId);

  const [state, dispatch] = useReducer(editorReducer, undefined, () => createEditorState());
  const [notice, setNotice] = useState<Notice | null>(null);

  const stageHandleRef = useRef<EditorStageHandle | null>(null);
  const hydratedRef = useRef(false);

  const document = state.history.present;

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
    (layer: EditorLayer): HTMLImageElement | undefined => {
      const url = materialUrlById[layer.materialId];
      return url ? images[url] : undefined;
    },
    [images, materialUrlById],
  );

  // ---- editor commands
  const handleAddMaterial = useCallback((material: EditorMaterial) => {
    dispatch({ type: 'ADD_LAYER', layer: createLayerFromMaterial(material) });
  }, []);

  const handleSelect = useCallback((layerId: string | null) => {
    dispatch({ type: 'SELECT_LAYER', layerId });
  }, []);

  const handleDragEnd = useCallback((layerId: string, x: number, y: number) => {
    dispatch({ type: 'COMMIT_LAYER', layerId, patch: { x, y } });
  }, []);

  const handleTransformEnd = useCallback((layerId: string, patch: Partial<EditorLayer>) => {
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
  const handleExport = useCallback(async () => {
    const handle = stageHandleRef.current;
    const stage = handle?.getStage();
    const filename = buildExportFileName();

    if (!handle || !stage) {
      setNotice({ kind: 'error', text: '画布尚未就绪，请稍后再试' });
      return;
    }

    dispatch({ type: 'SET_EXPORTING', exporting: true });
    let blob: Blob | null = null;

    try {
      blob = await exportStageToPng(stage, {
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

      const dataUrl = await blobToDataUrl(blob);
      const payload: ExportInput = { dataUrl, filename };
      const response = await sendToBackground<{ downloadId: number; filename: string }>({
        type: 'DOWNLOAD_COMPOSITE',
        requestId: createRequestId('download'),
        payload,
      });
      if (!response?.ok) {
        throw new AppError(ErrorCode.UNKNOWN, response?.error?.message ?? '下载失败');
      }
      setNotice({ kind: 'ok', text: `已下载 ${filename}（800×800 白底 PNG）` });
    } catch (error) {
      // A failed export must never clear the canvas.
      if (blob) {
        try {
          await downloadBlobInPage(blob, filename);
          setNotice({ kind: 'ok', text: `已通过页面下载 ${filename}` });
          return;
        } catch {
          /* fall through to the error notice */
        }
      }
      setNotice({ kind: 'error', text: `导出失败：${messageOf(error)}` });
    } finally {
      dispatch({ type: 'SET_EXPORTING', exporting: false });
    }
  }, []);

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
        showWhiteBackground={state.showWhiteBackground}
        layerCount={document.layers.length}
        sourceUrl={sessionId}
        onBack={() => void handleBack()}
        onUndo={handleUndo}
        onRedo={handleRedo}
        onToggleBackground={handleToggleBackground}
        onClear={handleClear}
        onExport={() => void handleExport()}
      />

      <div className="progress-line">
        <span>
          抠图进度：{progress.success + progress.failed}/{progress.total}
        </span>
        <span>成功 {progress.success}</span>
        <span>失败 {progress.failed}</span>
        <span>进行中 {progress.active}</span>
        <span>排队 {progress.waiting}</span>
      </div>

      {notice ? (
        <div className={`notice${notice.kind === 'error' ? ' notice--error' : ''}`}>{notice.text}</div>
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
            selectedLayerId={state.selectedLayerId}
            onSelect={handleSelect}
            onDragEnd={handleDragEnd}
            onTransformEnd={handleTransformEnd}
            handleRef={stageHandleRef}
          />
        </div>

        <LayerPanel
          layers={document.layers}
          selectedLayerId={state.selectedLayerId}
          onSelect={handleSelect}
          onMove={handleMoveLayer}
          onDelete={handleDeleteLayer}
          onMoveEnd={() => undefined}
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
