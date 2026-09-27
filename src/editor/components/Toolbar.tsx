export interface ToolbarProps {
  canUndo: boolean;
  canRedo: boolean;
  exporting: boolean;
  showWhiteBackground: boolean;
  layerCount: number;
  sourceUrl: string;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onToggleBackground: () => void;
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
    onBack,
    onUndo,
    onRedo,
    onToggleBackground,
    onClear,
    onExport,
  } = props;

  return (
    <header className="toolbar">
      <button type="button" onClick={onBack}>
        返回商品页
      </button>
      <span className="toolbar__title">800×800 主图编辑器</span>
      <span className="toolbar__hint" title={sourceUrl}>
        图层 {layerCount}
      </span>

      <span className="toolbar__spacer" />

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
      <button type="button" className="primary" onClick={onExport} disabled={exporting || layerCount === 0}>
        {exporting ? '导出中…' : '下载 PNG（800×800 白底）'}
      </button>
    </header>
  );
}
