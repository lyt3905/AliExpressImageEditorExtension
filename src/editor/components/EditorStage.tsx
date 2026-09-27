import { useCallback, useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Image as KonvaImage, Layer, Rect, Stage, Text as KonvaText, Transformer } from 'react-konva';
import { CANVAS_SIZE, WATERMARK_LAYER_ID } from '../../shared/constants';
import type { EditorLayer, ImageLayer, LayerPatch, WatermarkLayer } from '../../shared/types';
import { estimateTextHeight } from '../state/editor-reducer';

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
  /** Only picture layers resolve to images — text never enters this map. */
  imageForLayer: (layer: ImageLayer) => HTMLImageElement | undefined;
  /** Locked watermark frame drawn above every user layer (null = none). */
  watermark: WatermarkLayer | null;
  watermarkImage: HTMLImageElement | undefined;
  selectedLayerId: string | null;
  onSelect: (layerId: string | null) => void;
  onDragEnd: (layerId: string, x: number, y: number) => void;
  onTransformEnd: (layerId: string, patch: LayerPatch) => void;
  handleRef: React.MutableRefObject<EditorStageHandle | null>;
}

export function EditorStage(props: EditorStageProps): JSX.Element {
  const {
    layers,
    imageForLayer,
    watermark,
    watermarkImage,
    selectedLayerId,
    onSelect,
    onDragEnd,
    onTransformEnd,
    handleRef,
  } = props;

  const shellRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const [stageSize, setStageSize] = useState(MIN_PREVIEW_SIZE);

  /**
   * Text nodes are measured after paint so their `offsetY` can centre them.
   * Konva.Text height depends on line wrapping, which is only known once the
   * node has been laid out — the first frame uses `estimateTextHeight` instead.
   */
  const textNodesRef = useRef<Map<string, Konva.Text>>(new Map());
  const [textHeights, setTextHeights] = useState<Record<string, number>>({});

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

  // Keep the measured text heights in sync with what is actually drawn.
  useEffect(() => {
    let changed = false;
    const measured: Record<string, number> = {};
    for (const [id, node] of textNodesRef.current) {
      if (!node) continue;
      const height = node.height();
      if (height <= 0) continue;
      measured[id] = height;
      if (textHeights[id] !== height) changed = true;
    }
    // Re-running with identical measurements must not loop forever.
    if (changed) setTextHeights(measured);
  }, [layers, textHeights]);

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
    // Belt and braces: the watermark is locked, so it never gets handles.
    const selectable = node && node.name() !== WATERMARK_LAYER_ID ? node : null;
    transformer.nodes(selectable ? [selectable] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedLayerId, layers, previewScale, watermark]);

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
            if (layer.kind === 'text') {
              /*
                Outline and shadow are drawn in the node's own coordinate space,
                so they scale with the layer exactly like the glyphs do: an
                outline of 4px stays visually proportional when the text is
                blown up to 200%.

                `fillAfterStrokeEnabled` matters — Konva centres the stroke on
                the glyph path, so without it half of the outline paints over
                the fill and the text looks thinner than it did before the
                outline was added.

                `shadowEnabled` is gated on blur/offsets because Konva counts a
                set `shadowColor` alone as "has shadow", which would allocate a
                buffer canvas to draw a completely invisible shadow.

                The transformer box is unaffected: Konva hardcodes
                `skipShadow: true` and honours our `ignoreStroke` when measuring
                the attached node, so neither option inflates the handles.
              */
              const hasShadow =
                layer.shadowBlur > 0 || layer.shadowOffsetX !== 0 || layer.shadowOffsetY !== 0;
              return (
                <KonvaText
                  key={layer.id}
                  id={layer.id}
                  ref={(node) => {
                    if (node) textNodesRef.current.set(layer.id, node);
                    else textNodesRef.current.delete(layer.id);
                  }}
                  text={layer.text}
                  x={layer.x}
                  y={layer.y}
                  width={layer.width}
                  // Offset by half the box so (x, y) stays the centre, exactly like pictures.
                  offsetX={layer.width / 2}
                  offsetY={(textHeights[layer.id] ?? estimateTextHeight(layer)) / 2}
                  fontSize={layer.fontSize}
                  fontFamily={layer.fontFamily}
                  fontStyle={layer.fontStyle}
                  fill={layer.fill}
                  align={layer.align}
                  stroke={layer.stroke}
                  strokeWidth={layer.strokeWidth}
                  fillAfterStrokeEnabled
                  shadowEnabled={hasShadow}
                  shadowColor={layer.shadowColor}
                  shadowBlur={layer.shadowBlur}
                  shadowOffsetX={layer.shadowOffsetX}
                  shadowOffsetY={layer.shadowOffsetY}
                  shadowOpacity={layer.shadowOpacity}
                  scaleX={layer.scale}
                  scaleY={layer.scale}
                  rotation={layer.rotation}
                  draggable
                  onClick={() => onSelect(layer.id)}
                  onTap={() => onSelect(layer.id)}
                  onDragEnd={(event) => onDragEnd(layer.id, event.target.x(), event.target.y())}
                  onTransformEnd={(event) => {
                    const node = event.target as Konva.Text;
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
            }

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

          {/*
            Locked watermark frame: drawn last so it always sits on top of every
            user layer, and `listening={false}` makes it impossible to click,
            drag or transform. It is not part of the layer document, so UNDO /
            REDO / CLEAR cannot remove it either.
          */}
          {watermark && watermarkImage ? (
            <KonvaImage
              key={watermark.id}
              id={watermark.id}
              name={WATERMARK_LAYER_ID}
              image={watermarkImage}
              x={watermark.x}
              y={watermark.y}
              offsetX={watermark.sourceWidth / 2}
              offsetY={watermark.sourceHeight / 2}
              scaleX={watermark.scale}
              scaleY={watermark.scale}
              rotation={watermark.rotation}
              listening={false}
            />
          ) : null}

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
