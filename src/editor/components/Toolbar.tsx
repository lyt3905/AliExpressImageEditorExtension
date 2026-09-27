import { useRef, type ChangeEvent } from 'react';
import { SUPPORTED_IMAGE_MIME_TYPES } from '../../shared/image-mime';

export interface ToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  exporting: boolean;
  showWhiteBackground: boolean;
  layerCount: number;
  sourceUrl: string;
  /** Configured watermark frames, for the temporary switcher. */
  watermarkOptions: Array<{ id: string; name: string }>;
  activeWatermarkId: string | null;
  watermarkEnabled: boolean;
  onBack: () => void;
  onAddText: () => void;
  /** Local files from the picker; clipboard paste goes through the same path. */
  onUpload: (files: File[]) => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleBackground: () => void;
  onToggleWatermark: () => void;
  onSelectWatermark: (id: string | null) => void;
  onClear: () => void;
  onExport: () => void;
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const {
    canUndo,
    canRedo,
    exporting,
    showWhiteBackground,
    layerCount,
    sourceUrl,
    watermarkOptions,
    activeWatermarkId,
    watermarkEnabled,
    onBack,
    onAddText,
    onUpload,
    onUndo,
    onRedo,
    onToggleBackground,
    onToggleWatermark,
    onSelectWatermark,
    onClear,
    onExport,
  } = props;

  const hasWatermarks = watermarkOptions.length > 0;
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    // Clear first: picking the very same file again must still fire a change.
    event.target.value = '';
    if (files.length) onUpload(files);
  };

  return (
    <header className="toolbar">
      <button type="button" onClick={onBack}>
        返回商品页
      </button>
      <span className="toolbar__title">800×800 主图编辑器</span>
      <span className="toolbar__hint" title={sourceUrl}>
        图层 {layerCount}
      </span>

      <button type="button" onClick={onAddText}>
        添加文字
      </button>

      {/* Hidden (.toolbar__file) and opened by the button below it. */}
      <input
        ref={fileInputRef}
        type="file"
        className="toolbar__file"
        accept={SUPPORTED_IMAGE_MIME_TYPES.join(',')}
        multiple
        onChange={handleFiles}
      />
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        title="从本地选择图片，或直接 Ctrl+V 粘贴截图（会自动抠图）"
      >
        上传图片
      </button>

      <span className="toolbar__spacer" />

      <label className="toolbar__check" title="显示 / 隐藏水印框（不改动默认设置）">
        <input
          type="checkbox"
          checked={watermarkEnabled && hasWatermarks}
          disabled={!hasWatermarks}
          onChange={onToggleWatermark}
        />
        水印
      </label>
      <select
        className="toolbar__select"
        value={activeWatermarkId ?? ''}
        disabled={!hasWatermarks}
        title={
          hasWatermarks
            ? '临时切换本次使用的水印框（不会改变 Options 里的默认设置）'
            : '还没有配置水印框，请到扩展设置里添加'
        }
        onChange={(event) => onSelectWatermark(event.target.value || null)}
      >
        <option value="">不使用水印</option>
        {watermarkOptions.map((option) => (
          <option key={option.id} value={option.id}>
            {option.name}
          </option>
        ))}
      </select>

      <button type="button" onClick={onUndo} disabled={!canUndo}>
        撤销
      </button>
      <button type="button" onClick={onRedo} disabled={!canRedo}>
        重做
      </button>
      <button type="button" onClick={onClear} disabled={layerCount === 0}>
        清空画布
      </button>
      <button type="button" onClick={onToggleBackground}>
        {showWhiteBackground ? '预览：白底' : '预览：透明'}
      </button>
      {/* A watermark-only composition is still worth exporting. */}
      <button
        type="button"
        className="primary"
        onClick={onExport}
        disabled={exporting || (layerCount === 0 && !watermarkEnabled)}
      >
        {exporting ? '导出中…' : '下载 PNG（800×800 白底）'}
      </button>
    </header>
  );
}
