import { TEXT_LAYER_LABEL_MAX } from '../../shared/constants';
import type { EditorLayer, LayerPatch, TextLayer } from '../../shared/types';
import type { TransformCommand } from '../state/transform';
import { TextPropertiesEditor } from './TextPropertiesEditor';
import { TransformControls } from './TransformControls';

export interface LayerPanelProps {
  layers: EditorLayer[];
  /** Locked watermark frame, shown as a pinned row above the stack. */
  watermark: { name: string } | null;
  selectedLayerId: string | null;
  /** Set when the current selection is a text layer — drives the properties editor. */
  selectedTextLayer: TextLayer | null;
  onSelect: (layerId: string | null) => void;
  onMove: (layerId: string, direction: 'up' | 'down') => void;
  onDelete: (layerId: string) => void;
  onMoveEnd: () => void;
  onCommitText: (layerId: string, patch: LayerPatch) => void;
  /** Reset the selected text layer to the factory style and forget the preference. */
  onResetTextStyle: (layerId: string) => void;
  /** 左转 / 右转 / 镜像 for the selected layer — one history step each. */
  onTransform: (layerId: string, command: TransformCommand) => void;
  /** Knob drag: painted on the canvas only. */
  onRotatePreview: (layerId: string, rotation: number) => void;
  /** Knob release / arrow key: one history step. */
  onRotateCommit: (layerId: string, rotation: number) => void;
}

const KIND_LABEL: Record<EditorLayer['kind'], string> = {
  original: '原图',
  cutout: '抠图',
  text: '文字',
};

/** Collapse newlines so a multi-line text still fits on one row. */
function flattenText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function layerLabel(layer: EditorLayer, stackIndex: number): string {
  if (layer.kind === 'text') {
    const flat = flattenText(layer.text);
    if (!flat) return 'T 空文字';
    const clipped =
      flat.length > TEXT_LAYER_LABEL_MAX ? `${flat.slice(0, TEXT_LAYER_LABEL_MAX)}…` : flat;
    return `T ${clipped}`;
  }
  // Pictures: originals stay numbered so several scans remain distinguishable.
  return layer.kind === 'original' ? `${KIND_LABEL.original} #${stackIndex + 1}` : KIND_LABEL.cutout;
}

function layerTitle(layer: EditorLayer): string {
  if (layer.kind === 'text') return `文字 · ${flattenText(layer.text) || '空文字'}`;
  return `${KIND_LABEL[layer.kind]} · ${layer.sourceWidth}x${layer.sourceHeight}`;
}

export function LayerPanel({
  layers,
  watermark,
  selectedLayerId,
  selectedTextLayer,
  onSelect,
  onMove,
  onDelete,
  onMoveEnd,
  onCommitText,
  onResetTextStyle,
  onTransform,
  onRotatePreview,
  onRotateCommit,
}: LayerPanelProps): JSX.Element {
  // The panel lists the topmost layer first, mirroring the visual stack.
  const ordered = [...layers].reverse();
  // Derived here rather than passed in: the panel already owns both halves.
  const selectedLayer = layers.find((layer) => layer.id === selectedLayerId) ?? null;

  return (
    <aside className="panel">
      <div className="panel__title">
        <span>图层</span>
        <span className="toolbar__hint">{layers.length + (watermark ? 1 : 0)}</span>
      </div>
      <div className="panel__body">
        {/*
          Mirror / rotate always targets the CURRENT selection, so the controls
          only exist while something is selected. The idle line points at that
          requirement instead of hiding the feature without a trace.
        */}
        {selectedLayer ? (
          <TransformControls
            layer={selectedLayer}
            onCommand={onTransform}
            onRotatePreview={onRotatePreview}
            onRotateCommit={onRotateCommit}
          />
        ) : layers.length > 0 ? (
          <p className="transform-controls__hint transform-controls__hint--idle">
            选中一个图层后，可对它镜像 / 旋转。
          </p>
        ) : null}

        {selectedTextLayer ? (
          <TextPropertiesEditor
            layer={selectedTextLayer}
            onCommit={onCommitText}
            onResetStyle={onResetTextStyle}
          />
        ) : null}

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
              <span className="layer-row__name" title={layerTitle(layer)}>
                {layerLabel(layer, layers.indexOf(layer))}
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
