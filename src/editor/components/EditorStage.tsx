import { useCallback, useEffect, useRef, useState } from 'react';
import Konva from 'konva';
import { Image as KonvaImage, Layer, Rect, Stage, Text as KonvaText, Transformer } from 'react-konva';
import { CANVAS_SIZE, WATERMARK_LAYER_ID } from '../../shared/constants';
import type { EditorLayer, ImageLayer, LayerPatch, WatermarkLayer } from '../../shared/types';
import { estimateTextHeight } from '../state/editor-reducer';
import { axisScale, splitSignedScale } from '../state/transform';

/** Largest visual size of the canvas preview. The logical canvas stays 800x800. */
export const MAX_PREVIEW_SIZE = 640;
const MIN_PREVIEW_SIZE = 240;
const MIN_LAYER_SIDE = 8;

export interface EditorStageHandle {
  getStage(): Konva.Stage | null;
  /**
   * Visual scale of the preview (`stageSize / 800`).
   *
   * Do NOT feed this into the export as `1 / scale`: that double rounding loses a
   * ulp for a third of the preview sizes and silently produces 799x799 PNGs. The
   * exporter derives its ratio from the stage's own pixel width instead — see
   * `services/exporter.ts`.
   */
  getPreviewScale(): number;
  setChromeVisible(visible: boolean): void;
  /**
   * Paint a rotation onto one layer without dispatching anything.
   *
   * Used by the rotation knob while it is dragged. The preview has to bypass
   * React state: routing it through UPDATE_LAYER would leave the previewed
   * document as `history.present`, and the commit that follows would then push
   * *that* onto the past stack — so undo would restore the angle the user just
   * dialled in and appear to do nothing. This is the same trade the transformer
   * already makes: Konva moves the node live, one COMMIT lands at the end.
   *
   * The selection box needs no extra nudge: Konva's rotation setter fires
   * `rotationChange`, and Konva subscribes the Transformer to that event, so it
   * re-measures on its own.
   */
  setLayerRotation(layerId: string, rotation: number): void;
}

export interface EditorStageProps {
  layers: EditorLayer[];
  /** Only picture layers resolve to images — text never enters this map. */
  imageForLayer: (layer: ImageLayer) => HTMLImageElement | undefined;
  /** Locked watermark frame drawn above every user layer (null = none). */
  watermark: WatermarkLayer | null;
  watermarkImage: HTMLImageElement | undefined;
  /**
   * Layer drawn ABOVE the watermark frame (the auto-added product code).
   *
   * The watermark is a locked frame the seller wants on the composition, but
   * the product code must stay readable on top of it, so this one layer is
   * painted after the watermark instead of with the rest of the stack.
   */
  foregroundLayerId?: string | null;
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
    foregroundLayerId,
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
    if (selectable) {
      /*
        Text layers get SIDE anchors only: dragging them is a wrap-width change
        (`width`), not a font-size change. Corner handles stay for pictures; a
        text resize still goes through `bakeTextScale` below, reachable from
        the panel's own controls.
      */
      const isText = selectable.getAttr('text') !== undefined && selectable instanceof Konva.Text;
      transformer.enabledAnchors(
        isText
          ? ['middle-left', 'middle-right']
          : ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
      );
    }
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
      setLayerRotation: (layerId: string, rotation: number) => {
        const node = stageRef.current?.findOne<Konva.Node>(`#${layerId}`);
        if (!node) return;
        node.rotation(rotation);
        node.getLayer()?.batchDraw();
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

  /** Layer whose drag was taken over by the selection; its dragend is ignored. */
  const suppressDragEndRef = useRef<string | null>(null);

  /**
   * Hand a drag to the selected layer.
   *
   * A picture can be completely covered by an opaque layer above it — then no
   * amount of clicking reaches it on the canvas, and dragging moves the top
   * layer instead ("移动错误"). When the press landed inside the selected
   * layer (`intersects` is alpha-accurate thanks to the custom hitFunc), the
   * gesture belongs to the selection: cancel this layer's drag and start the
   * selected one from the same pointer position.
   */
  const handoffDragToSelection = useCallback(
    (event: Konva.KonvaEventObject<MouseEvent | TouchEvent | DragEvent>) => {
      const node = event.target;
      if (!selectedLayerId || node.id() === selectedLayerId) return;
      const stage = node.getStage();
      const pointer = stage?.getPointerPosition();
      if (!stage || !pointer) return;
      const selected = stage.findOne<Konva.Shape>(`#${selectedLayerId}`);
      if (!selected || !(selected instanceof Konva.Shape)) return;
      if (!selected.intersects(pointer)) return;

      suppressDragEndRef.current = node.id();
      node.stopDrag();
      selected.startDrag();
    },
    [selectedLayerId],
  );

  /**
   * Paint order, front to back: the whole user stack, then the locked
   * watermark, then the foreground layer (product code) so it stays on top of
   * the watermark while still being selectable and draggable.
   */
  type DrawItem = EditorLayer | { watermark: true };
  const watermarkItem: DrawItem = { watermark: true };
  const drawItems: DrawItem[] = [
    ...layers.filter((layer) => layer.id !== foregroundLayerId),
    ...(watermark && watermarkImage ? [watermarkItem] : []),
    ...layers.filter((layer) => layer.id === foregroundLayerId),
  ];

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

          {drawItems.map((item) => {
            /*
              The watermark frame is a draw-order sentinel rather than a layer
              document entry: it is locked (never clickable, never in the undo
              stack) but must sit ABOVE the pictures and BELOW the product code.
            */
            if ('watermark' in item) {
              const frame = watermark;
              if (!frame || !watermarkImage) return null;
              return (
                <KonvaImage
                  key={frame.id}
                  id={frame.id}
                  name={WATERMARK_LAYER_ID}
                  image={watermarkImage}
                  x={frame.x}
                  y={frame.y}
                  offsetX={frame.sourceWidth / 2}
                  offsetY={frame.sourceHeight / 2}
                  scaleX={frame.scale}
                  scaleY={frame.scale}
                  rotation={frame.rotation}
                  listening={false}
                />
              );
            }

            const layer = item;
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
                  scaleX={axisScale(layer, 'x')}
                  scaleY={axisScale(layer, 'y')}
                  rotation={layer.rotation}
                  draggable
                  /*
                    Hit detection for text is only the glyph box, not the whole
                    wrap-width rectangle: a 400px-wide one-line label would
                    otherwise sit on top of the picture below and swallow every
                    click meant for it. `fontSize` approximates one line's
                    height (Konva's default lineHeight = 1).
                  */
                  hitFunc={(context, shape) => {
                    const height = textHeights[layer.id] ?? estimateTextHeight(layer);
                    context.beginPath();
                    context.rect(0, 0, layer.width, height);
                    context.fillStrokeShape(shape);
                  }}
                  onClick={() => onSelect(layer.id)}
                  onTap={() => onSelect(layer.id)}
                  onDragEnd={(event) => onDragEnd(layer.id, event.target.x(), event.target.y())}
                  onTransformEnd={(event) => {
                    const node = event.target as Konva.Text;
                    const signedX = node.scaleX();
                    const signedY = node.scaleY();
                    /*
                      Text layers only expose the middle-left / middle-right
                      anchors, so a drag is a WRAP-WIDTH change, not a resize:
                      fold scaleX back into `width` and keep `fontSize` alone.
                      The vertical scale is reset with the horizontal one —
                      a text layer's height follows its wrap, never a drag.
                    */
                    const newWidth = Math.max(32, Math.round(layer.width * Math.abs(signedX)));
                    node.width(newWidth);
                    node.scaleX(1);
                    node.scaleY(1);
                    // Keep (x, y) the centre: offsetX tracks half the new width.
                    node.offsetX(newWidth / 2);
                    const { flipX, flipY } = splitSignedScale(signedX, signedY);
                    onTransformEnd(layer.id, {
                      x: node.x(),
                      y: node.y(),
                      width: newWidth,
                      rotation: node.rotation(),
                      flipX,
                      flipY,
                    });
                  }}
                />
              );
            }

            if (layer.kind === 'plate') {
              /*
                A plain filled rectangle: no image, no hit trick. Unlike a cut-out it
                is fully opaque, so the default rectangle hit area is exactly right —
                and it must NOT fall through to `imageForLayer`, which would look up a
                material that does not exist.
              */
              return (
                <Rect
                  key={layer.id}
                  id={layer.id}
                  x={layer.x}
                  y={layer.y}
                  width={layer.width}
                  height={layer.height}
                  // Centre-anchored like every other layer.
                  offsetX={layer.width / 2}
                  offsetY={layer.height / 2}
                  fill={layer.fill}
                  cornerRadius={layer.cornerRadius}
                  scaleX={axisScale(layer, 'x')}
                  scaleY={axisScale(layer, 'y')}
                  rotation={layer.rotation}
                  draggable
                  onClick={() => onSelect(layer.id)}
                  onTap={() => onSelect(layer.id)}
                  onDragStart={handoffDragToSelection}
                  onDragEnd={(event) => {
                    if (suppressDragEndRef.current === layer.id) {
                      suppressDragEndRef.current = null;
                      return;
                    }
                    onDragEnd(layer.id, event.target.x(), event.target.y());
                  }}
                  onTransformEnd={(event) => {
                    const node = event.target as Konva.Rect;
                    const signedX = node.scaleX();
                    const signedY = node.scaleY();
                    // Same normalisation as pictures: `scale` stays the source of truth.
                    node.scaleX(1);
                    node.scaleY(1);
                    onTransformEnd(layer.id, {
                      x: node.x(),
                      y: node.y(),
                      ...splitSignedScale(signedX, signedY),
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
                scaleX={axisScale(layer, 'x')}
                scaleY={axisScale(layer, 'y')}
                rotation={layer.rotation}
                draggable
                /*
                  Alpha-accurate hit area.

                  Konva's default hit for an image is its whole rectangle, so a
                  cutout's transparent background swallows every click meant for
                  the picture underneath — the "移动错图层" bug. Drawing the
                  image into the hit canvas and then compositing the hit colour
                  `source-in` keeps only the opaque pixels, so transparent areas
                  fall through to the layer below.

                  Konva only resolves a shape when the hit pixel is fully opaque
                  (alpha 255), which the composite produces exactly on the solid
                  pixels.
                */
                hitFunc={(context, shape) => {
                  context.save();
                  context.beginPath();
                  context.rect(0, 0, layer.sourceWidth, layer.sourceHeight);
                  context.closePath();
                  context.clip();
                  context.drawImage(
                    image,
                    0,
                    0,
                    image.width,
                    image.height,
                    0,
                    0,
                    layer.sourceWidth,
                    layer.sourceHeight,
                  );
                  context.setAttr('globalCompositeOperation', 'source-in');
                  context.fillStrokeShape(shape);
                  context.restore();
                }}
                onClick={() => onSelect(layer.id)}
                onTap={() => onSelect(layer.id)}
                onDragStart={handoffDragToSelection}
                onDragEnd={(event) => {
                  // A drag this layer merely grabbed on behalf of the selection
                  // must not move it or commit a history step.
                  if (suppressDragEndRef.current === layer.id) {
                    suppressDragEndRef.current = null;
                    return;
                  }
                  onDragEnd(layer.id, event.target.x(), event.target.y());
                }}
                onTransformEnd={(event) => {
                  const node = event.target as Konva.Image;
                  const signedX = node.scaleX();
                  const signedY = node.scaleY();
                  // Normalise the node back to scale 1 so `scale` stays the single source of truth.
                  node.scaleX(1);
                  node.scaleY(1);
                  onTransformEnd(layer.id, {
                    x: node.x(),
                    y: node.y(),
                    // The transformer reports a SIGNED scale for a mirrored
                    // layer; the document keeps magnitude and mirror apart.
                    ...splitSignedScale(signedX, signedY),
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
