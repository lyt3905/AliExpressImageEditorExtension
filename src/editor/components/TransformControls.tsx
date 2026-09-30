/**
 * 镜像 / 旋转 controls for the currently selected layer.
 *
 * One layer at a time, because that is what the panel's selection already means.
 * Shown for every layer kind — a rotated or mirrored text is as reasonable as a
 * rotated cutout — and every control here produces exactly ONE history step:
 * the buttons commit on click, the knob commits when the drag ends.
 */

import type { EditorLayer } from '../../shared/types';
import { normalizeRotation, type TransformCommand } from '../state/transform';
import { RotationKnob } from './RotationKnob';

export interface TransformControlsProps {
  layer: EditorLayer;
  /** 左转 / 右转 / 镜像 — one committed step each. */
  onCommand: (layerId: string, command: TransformCommand) => void;
  /** Live knob value; painted on the canvas only, never in the history stack. */
  onRotatePreview: (layerId: string, rotation: number) => void;
  /** Pointer release / arrow key — exactly one history entry. */
  onRotateCommit: (layerId: string, rotation: number) => void;
}

/** Which button lights up for each mirror flag. */
const MIRROR_BUTTONS: Array<{
  command: TransformCommand;
  label: string;
  axis: 'flipX' | 'flipY';
  title: string;
}> = [
  { command: 'flip-x', label: '水平镜像', axis: 'flipX', title: '左右镜像（水平翻转）。再点一次还原' },
  { command: 'flip-y', label: '垂直镜像', axis: 'flipY', title: '上下镜像（垂直翻转）。再点一次还原' },
];

export function TransformControls({
  layer,
  onCommand,
  onRotatePreview,
  onRotateCommit,
}: TransformControlsProps): JSX.Element {
  return (
    <section className="transform-controls">
      <h3 className="panel__group-title">
        <span>镜像 / 旋转</span>
      </h3>

      <div className="transform-controls__body">
        <RotationKnob
          rotation={normalizeRotation(layer.rotation)}
          onPreview={(next) => onRotatePreview(layer.id, next)}
          onCommit={(next) => onRotateCommit(layer.id, next)}
        />
        <div className="transform-controls__grid">
          <button
            type="button"
            title="逆时针旋转 90°"
            onClick={() => onCommand(layer.id, 'rotate-ccw')}
          >
            左转 90°
          </button>
          <button
            type="button"
            title="顺时针旋转 90°"
            onClick={() => onCommand(layer.id, 'rotate-cw')}
          >
            右转 90°
          </button>
          {MIRROR_BUTTONS.map((button) => (
            <button
              key={button.command}
              type="button"
              className={layer[button.axis] === true ? 'is-active' : ''}
              title={button.title}
              onClick={() => onCommand(layer.id, button.command)}
            >
              {button.label}
            </button>
          ))}
        </div>
      </div>

      <p className="transform-controls__hint">
        拖动旋钮调任意角度（按住 Shift 每 15° 吸附，双击归零）；也能直接拖画布上的旋转手柄。
      </p>
    </section>
  );
}
