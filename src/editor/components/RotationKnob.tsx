/**
 * Rotary angle control for the selected layer.
 *
 * The live preview is painted straight onto the Konva node (through
 * `EditorStageHandle.setLayerRotation`) and only the release is committed, so one
 * drag is exactly one undo step and no React render happens at pointer speed.
 * See `setLayerRotation` for why the preview must not go through UPDATE_LAYER.
 *
 * The angle it draws while dragging is its own local state: the committed
 * `rotation` prop does not move until the pointer is released, so a knob reading
 * from the prop would sit frozen for the whole gesture.
 */

import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ROTATE_NUDGE_DEG, ROTATE_SNAP_DEG } from '../../shared/constants';
import { normalizeRotation, shortestDelta, snapRotation } from '../state/transform';

const KNOB_SIZE = 76;
const CENTRE = KNOB_SIZE / 2;
const RING_RADIUS = 33;

export interface RotationKnobProps {
  /** The layer's committed angle, already wrapped into [0, 360). */
  rotation: number;
  /** Live value during a drag — must not create a history entry. */
  onPreview: (rotation: number) => void;
  /** One committed step: pointer release, each arrow key, the double-click reset. */
  onCommit: (rotation: number) => void;
}

interface DragState {
  pointerId: number;
  /** Pointer angle at the previous move, in the atan2 convention. */
  lastAngle: number;
  /** How far the pointer has swept since pointerdown. */
  total: number;
  /** The layer's angle when the gesture started. */
  startRotation: number;
  /** The value currently painted on the canvas. */
  value: number;
}

export function RotationKnob({ rotation, onPreview, onCommit }: RotationKnobProps): JSX.Element {
  const dragRef = useRef<DragState | null>(null);
  const [liveRotation, setLiveRotation] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);

  const shown = liveRotation ?? rotation;

  const pointerAngle = (event: ReactPointerEvent<SVGSVGElement>): number => {
    const rect = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    // Screen convention: 0° points right and grows clockwise (y grows downwards),
    // which is also how Konva measures `rotation`.
    return (Math.atan2(dy, dx) * 180) / Math.PI;
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    event.preventDefault();
    const angle = pointerAngle(event);
    dragRef.current = {
      pointerId: event.pointerId,
      lastAngle: angle,
      total: 0,
      startRotation: rotation,
      value: rotation,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const angle = pointerAngle(event);
    // Accumulate the SHORTEST step, never a raw difference: past ±180° a raw
    // one flips sign and the layer would jump a whole turn under the cursor.
    drag.total += shortestDelta(angle - drag.lastAngle);
    drag.lastAngle = angle;
    const raw = drag.startRotation + drag.total;
    const next = event.shiftKey ? snapRotation(raw) : normalizeRotation(raw);
    drag.value = next;
    setLiveRotation(next);
    onPreview(next);
  };

  const finishDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    setLiveRotation(null);
    if (drag.value === drag.startRotation) {
      // A click that never turned anything: put the node back and commit nothing,
      // so merely touching the knob cannot cost an undo step.
      onPreview(drag.startRotation);
      return;
    }
    onCommit(drag.value);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    const step = event.shiftKey ? ROTATE_SNAP_DEG : ROTATE_NUDGE_DEG;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
      event.preventDefault();
      onCommit(normalizeRotation(rotation - step));
    } else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
      event.preventDefault();
      onCommit(normalizeRotation(rotation + step));
    } else if (event.key === 'Home') {
      event.preventDefault();
      onCommit(0);
    }
  };

  return (
    <svg
      className={`knob${dragging ? ' knob--dragging' : ''}`}
      width={KNOB_SIZE}
      height={KNOB_SIZE}
      viewBox={`0 0 ${KNOB_SIZE} ${KNOB_SIZE}`}
      role="slider"
      aria-label="旋转角度"
      aria-valuemin={0}
      aria-valuemax={360}
      aria-valuenow={Math.round(shown)}
      tabIndex={0}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onKeyDown={handleKeyDown}
      onDoubleClick={() => {
        // Guarded: a reset that changes nothing would still push an undo step.
        if (rotation !== 0) onCommit(0);
      }}
    >
      {/* SVG has no `title` attribute — the tooltip is a child element. */}
      <title>拖动旋钮调整角度；按住 Shift 每 15° 吸附；双击归零；也可用方向键微调</title>
      <circle className="knob__box" cx={CENTRE} cy={CENTRE} r={RING_RADIUS} />
      {/*
        The dial needle points straight up at 0°, like a physical knob, and turns
        clockwise as the angle grows — the same direction the layer turns.
      */}
      <g transform={`rotate(${shown} ${CENTRE} ${CENTRE})`}>
        <line className="knob__pointer" x1={CENTRE} y1={CENTRE - 10} x2={CENTRE} y2={CENTRE - 26} />
        <circle className="knob__handle" cx={CENTRE} cy={CENTRE - 26} r={4} />
      </g>
      <text className="knob__value" x={CENTRE} y={CENTRE + 20}>
        {Math.round(shown)}°
      </text>
    </svg>
  );
}
