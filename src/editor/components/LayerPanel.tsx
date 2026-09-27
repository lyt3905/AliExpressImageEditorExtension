import type { EditorLayer } from '../../shared/types';

export interface LayerPanelProps {
  layers: EditorLayer[];
  /** Locked watermark frame, shown as a pinned row above the stack. */
  watermark: { name: string } | null;
  selectedLayerId: string | null;
  onSelect: (layerId: string | null) => void;
  onMove: (layerId: string, direction: 'up' | 'down') => void;
  onDelete: (layerId: string) => void;
  onMoveEnd: () => void;
}

const KIND_LABEL: Record<EditorLayer['kind'], string> = {
  original: '原图',
  cutout: '抠图',
  watermark: '水印框',
};

export function LayerPanel({
  layers,
  watermark,
  selectedLayerId,
  onSelect,
  onMove,
  onDelete,
  onMoveEnd,
}: LayerPanelProps): JSX.Element {
  // The panel lists the topmost layer first, mirroring the visual stack.
  const ordered = [...layers].reverse();

  return (
    <aside className="panel">
      <div className="panel__title">
        <span>图层</span>
        <span className="toolbar__hint">{layers.length + (watermark ? 1 : 0)}</span>
      </div>
      <div className="panel__body">
        {/*
          The watermark is pinned here for visibility, but it is not a document
          layer: no selection, no reorder, no delete.
        */}
        {watermark ? (
          <div className="layer-row layer-row--locked" title="水印框固定在最上层，不可编辑">
            <span className="layer-row__name">水印框 · {watermark.name}</span>
            <span className="layer-row__lock">锁定</span>
          </div>
        ) : null}

        {ordered.length === 0 ? (
          watermark ? null : (
            <div className="empty">画布为空，点击左侧素材加入</div>
          )
        ) : (
          ordered.map((layer) => (
            <div
              key={layer.id}
              className={`layer-row${layer.id === selectedLayerId ? ' layer-row--selected' : ''}`}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(layer.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onSelect(layer.id);
              }}
            >
              <span className="layer-row__name" title={`${KIND_LABEL[layer.kind]} · ${layer.sourceWidth}x${layer.sourceHeight}`}>
                {KIND_LABEL[layer.kind]}
                {layer.kind === 'original' ? ` #${layers.indexOf(layer) + 1}` : ''}
              </span>
              <div className="layer-row__actions">
                <button
                  type="button"
                  title="上移一层"
                  onClick={(event) => {
                    event.stopPropagation();
                    onMove(layer.id, 'up');
                    onMoveEnd();
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  title="下移一层"
                  onClick={(event) => {
                    event.stopPropagation();
                    onMove(layer.id, 'down');
                    onMoveEnd();
                  }}
                >
                  ↓
                </button>
                <button
                  type="button"
                  title="删除图层"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete(layer.id);
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
