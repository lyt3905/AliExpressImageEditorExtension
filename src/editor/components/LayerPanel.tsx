import type { EditorLayer } from '../../shared/types';

export interface LayerPanelProps {
  layers: EditorLayer[];
  selectedLayerId: string | null;
  onSelect: (layerId: string | null) => void;
  onMove: (layerId: string, direction: 'up' | 'down') => void;
  onDelete: (layerId: string) => void;
  onMoveEnd: () => void;
}

const KIND_LABEL: Record<EditorLayer['kind'], string> = {
  original: '原图',
  cutout: '抠图',
};

export function LayerPanel({
  layers,
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
        <span className="toolbar__hint">{layers.length}</span>
      </div>
      <div className="panel__body">
        {ordered.length === 0 ? (
          <div className="empty">画布为空，点击左侧素材加入</div>
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
