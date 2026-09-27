import { useCallback, useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Image as KonvaImage, Layer, Rect, Stage, Transformer } from 'react-konva';
import { CANVAS_SIZE } from '../../shared/constants';
import type { EditorLayer } from '../../shared/types';

/** Largest visual size of the canvas preview. The logical canvas stays 800x800. */
export const MAX_PREVIEW_SIZE = 640;
const MIN_PREVIEW_SIZE = 240;
const MIN_LAYER_SIDE = 8;

export interface EditorStageHandle {
  getStage(): Konva.Stage | null;
  getPreviewScale(): number;
  setChromeVisible(visible: boolean): void;
}

export interface EditorStageProps {
  layers: EditorLayer[];
  imageForLayer: (layer: EditorLayer) => HTMLImageElement | undefined;
  selectedLayerId: string | null;
  onSelect: (layerId: string | null) => void;
  onDragEnd: (layerId: string, x: number, y: number) => void;
  onTransformEnd: (layerId: string, patch: Partial<EditorLayer>) => void;
  handleRef: React.MutableRefObject<EditorStageHandle | null>;
}

export function EditorStage(props: EditorStageProps): JSX.Element {
  const { layers, imageForLayer, selectedLayerId, onSelect, onDragEnd, onTransformEnd, handleRef } = props;

  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [stageSize, setStageSize] = useState(MIN_PREVIEW_SIZE);

  const previewScale = stageSize / CANVAS_SIZE;
  const previewScaleRef = useRef(previewScale);
  previewScaleRef.current = previewScale;

  // Keep the preview square and inside the available space (window resize included).
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const parent = shell.parentElement;

    const measure = () => {
      const box = parent ?? shell;
      const available = Math.min(box.clientWidth - 24, box.clientHeight - 24, MAX_PREVIEW_SIZE);
      const size = Math.max(MIN_PREVIEW_SIZE, Math.floor(available / 2) * 2);
      setStageSize(size);
    };

    measure();
    if (typeof ResizeObserver !== 'function') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    if (parent) observer.observe(parent);
    return () => observer.disconnect();
  }, []);

  // Attach the transformer imperatively: it needs the Konva node instance.
  useEffect(() => {
    const transformer = transformerRef.current;
    const stage = stageRef.current;
    if (!transformer || !stage) return;
    if (!selectedLayerId) {
      transformer.nodes([]);
      return;
    }
    const node = stage.findOne<Konva.Node>(`#${selectedLayerId}`);
    transformer.nodes(node ? [node] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedLayerId, layers, previewScale]);

  const chromeVisibleRef = useRef(true);

  useEffect(() => {
    handleRef.current = {
      getStage: () => stageRef.current,
      getPreviewScale: () => previewScaleRef.current,
      setChromeVisible: (visible: boolean) => {
        chromeVisibleRef.current = visible;
        const transformer = transformerRef.current;
        if (transformer) transformer.visible(visible);
        const background = stageRef.current?.findOne<Konva.Rect>('.export-background');
        if (background) background.visible(!visible);
        stageRef.current?.batchDraw();
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  const handleStageMouseDown = useCallback(
    (event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (event.target === event.target.getStage()) onSelect(null);
    },
    [onSelect],
  );

  return (
    <div ref={shellRef} className="stage-shell">
      <Stage
        ref={stageRef}
        width={stageSize}
        height={stageSize}
        onMouseDown={handleStageMouseDown}
        onTouchStart={handleStageMouseDown}
      >
        <Layer scaleX={previewScale} scaleY={previewScale}>
          {/* Switched on only while exporting: the export is always white-background. */}
          <Rect
            name="export-background"
            x={0}
            y={0}
            width={CANVAS_SIZE}
            height={CANVAS_SIZE}
            fill="#ffffff"
            listening={false}
            visible={false}
          />

          {layers.map((layer) => {
            const image = imageForLayer(layer);
            if (!image) return null;
            return (
              <KonvaImage
                key={layer.id}
                id={layer.id}
                image={image}
                x={layer.x}
                y={layer.y}
                offsetX={layer.sourceWidth / 2}
                offsetY={layer.sourceHeight / 2}
                scaleX={layer.scale}
                scaleY={layer.scale}
                rotation={layer.rotation}
                draggable
                onClick={() => onSelect(layer.id)}
                onTap={() => onSelect(layer.id)}
                onDragEnd={(event) => onDragEnd(layer.id, event.target.x(), event.target.y())}
                onTransformEnd={(event) => {
                  const node = event.target as Konva.Image;
                  const scale = node.scaleX();
                  // Normalise the node back to scale 1 so `scale` stays the single source of truth.
                  node.scaleX(1);
                  node.scaleY(1);
                  onTransformEnd(layer.id, {
                    x: node.x(),
                    y: node.y(),
                    scale,
                    rotation: node.rotation(),
                  });
                }}
              />
            );
          })}

          <Transformer
            ref={transformerRef}
            rotateEnabled
            keepRatio
            flipEnabled={false}
            ignoreStroke
            enabledAnchors={['top-left', 'top-right', 'bottom-left', 'bottom-right']}
            anchorSize={10 / previewScale}
            anchorStroke="#1a73e8"
            anchorFill="#ffffff"
            borderStroke="#1a73e8"
            borderStrokeWidth={1.5 / previewScale}
            rotateAnchorOffset={28 / previewScale}
            boundBoxFunc={(oldBox, newBox) => {
              const minimum = MIN_LAYER_SIDE * previewScale;
              if (Math.abs(newBox.width) < minimum || Math.abs(newBox.height) < minimum) return oldBox;
              if (newBox.width < 0 || newBox.height < 0) return oldBox;
              return newBox;
            }}
          />
        </Layer>
      </Stage>
    </div>
  );
}
