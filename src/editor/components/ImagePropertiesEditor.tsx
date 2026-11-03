import { useEffect, useState } from 'react';
import { DEFAULT_IMAGE_EFFECTS, IMAGE_EFFECT_LIMITS } from '../../shared/constants';
import type { ImageEffects, ImageLayer } from '../../shared/types';
import { imageEffectsEqual, normalizeImageEffects } from '../../services/image-effects';

/**
 * The picture effect panel (10.22.0).
 *
 * Deliberately NOT a remembered style: the text panel writes every edit back to
 * `text-defaults` so the next text layer looks like the last one. A picture's
 * brightness or glow is a statement about THIS photograph — carrying it to the
 * next photo the seller drops in would silently darken a product shot. Reset is
 * therefore per layer, never global.
 */

interface EffectNumberProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  title?: string;
  onCommit: (next: number) => void;
}

/** Draft while typing, commit on blur/Enter — same rule as the text panel. */
function EffectNumber({ label, value, min, max, step = 1, title, onCommit }: EffectNumberProps): JSX.Element {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (): void => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = Math.min(max, Math.max(min, parsed));
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <label className="text-properties__field" title={title}>
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
      />
    </label>
  );
}

interface EffectColorProps {
  label: string;
  value: string;
  title?: string;
  onCommit: (next: string) => void;
}

function EffectColor({ label, value, title, onCommit }: EffectColorProps): JSX.Element {
  const [draft, setDraft] = useState(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <label className="text-properties__field text-properties__field--color" title={title}>
      <span>{label}</span>
      <input
        type="color"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (draft !== value) onCommit(draft);
        }}
      />
    </label>
  );
}

export interface ImagePropertiesEditorProps {
  layer: ImageLayer;
  onCommit: (layerId: string, effects: ImageEffects) => void;
}

export function ImagePropertiesEditor({ layer, onCommit }: ImagePropertiesEditorProps): JSX.Element {
  const effects = normalizeImageEffects(layer.effects);

  const apply = (patch: Partial<ImageEffects>): void => {
    const next = normalizeImageEffects({ ...effects, ...patch });
    // Every slider fires on blur, so an untouched field would otherwise push an
    // identical document onto the undo stack and make Ctrl+Z look broken.
    if (imageEffectsEqual(next, effects)) return;
    onCommit(layer.id, next);
  };

  const shadowOn =
    effects.shadowOpacity > 0 &&
    (effects.shadowBlur > 0 || effects.shadowOffsetX !== 0 || effects.shadowOffsetY !== 0);
  const glowOn = effects.glowOpacity > 0 && (effects.glowRadius > 0 || effects.glowBlur > 0);
  /*
    描边与发光是两件事：发光画的是"剪影本身加一圈光晕"（硬边就是剪影），海报要的
    是**剪影外面的色环**（`alpha-outline.ts` 用距离场算）。所以它必须单独开关。
  */
  const outlineOn = effects.outlineWidth > 0 && effects.outlineOpacity > 0;

  return (
    <section className="text-properties">
      <h3 className="panel__group-title">图片效果</h3>

      <div className="text-properties__row">
        <EffectNumber
          label="不透明度 %"
          value={Math.round(effects.opacity * 100)}
          min={0}
          max={100}
          title="只影响这一张图；背景与其它图层不受影响"
          onCommit={(next) => apply({ opacity: next / 100 })}
        />
        <EffectNumber
          label="亮度"
          value={Math.round(effects.brightness * 100)}
          min={-100}
          max={100}
          title="负值压暗、正值提亮；0 表示不动"
          onCommit={(next) => apply({ brightness: next / 100 })}
        />
      </div>

      <div className="text-properties__row text-properties__row--buttons">
        <button
          type="button"
          className={effects.grayscale ? 'is-active' : ''}
          title="只剩明度，颜色全部去掉"
          onClick={() => apply({ grayscale: !effects.grayscale })}
        >
          灰度
        </button>
      </div>

      <h4 className="text-properties__subtitle">阴影</h4>
      <div className="text-properties__row text-properties__row--buttons">
        <button
          type="button"
          className={shadowOn ? 'is-active' : ''}
          title={shadowOn ? '关掉这一张图的阴影' : '给这一张图加投影'}
          onClick={() =>
            apply(
              shadowOn
                ? { shadowOpacity: 0, shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0 }
                : { shadowOpacity: 0.35, shadowBlur: 12, shadowOffsetX: 0, shadowOffsetY: 8 },
            )
          }
        >
          {shadowOn ? '阴影：开' : '阴影：关'}
        </button>
      </div>
      {shadowOn ? (
        <>
          <div className="text-properties__row">
            <EffectColor
              label="颜色"
              value={effects.shadowColor}
              onCommit={(next) => apply({ shadowColor: next })}
            />
            <EffectNumber
              label="模糊"
              value={effects.shadowBlur}
              min={0}
              max={IMAGE_EFFECT_LIMITS.shadowBlur}
              title="阴影边缘的柔化程度（逻辑 px）"
              onCommit={(next) => apply({ shadowBlur: next })}
            />
            <EffectNumber
              label="不透明 %"
              value={Math.round(effects.shadowOpacity * 100)}
              min={0}
              max={100}
              onCommit={(next) => apply({ shadowOpacity: next / 100 })}
            />
          </div>
          <div className="text-properties__row">
            <EffectNumber
              label="偏移 X"
              value={effects.shadowOffsetX}
              min={-IMAGE_EFFECT_LIMITS.shadowOffset}
              max={IMAGE_EFFECT_LIMITS.shadowOffset}
              title="正值向右"
              onCommit={(next) => apply({ shadowOffsetX: next })}
            />
            <EffectNumber
              label="偏移 Y"
              value={effects.shadowOffsetY}
              min={-IMAGE_EFFECT_LIMITS.shadowOffset}
              max={IMAGE_EFFECT_LIMITS.shadowOffset}
              title="正值向下"
              onCommit={(next) => apply({ shadowOffsetY: next })}
            />
          </div>
        </>
      ) : null}

      <h4 className="text-properties__subtitle">描边</h4>
      <div className="text-properties__row text-properties__row--buttons">
        <button
          type="button"
          className={outlineOn ? 'is-active' : ''}
          title={outlineOn ? '关掉这一张图的描边' : '沿剪影外侧加一圈实心色环（海报风格的红色描边）'}
          onClick={() =>
            apply(
              outlineOn
                ? { outlineWidth: 0, outlineGlow: 0, outlineOpacity: 1 }
                : { outlineWidth: 4, outlineGlow: 14, outlineOpacity: 0.75, outlineColor: '#ff2638' },
            )
          }
        >
          {outlineOn ? '描边：开' : '描边：关'}
        </button>
      </div>
      {outlineOn ? (
        <>
          <div className="text-properties__row">
            <EffectColor
              label="颜色"
              value={effects.outlineColor}
              onCommit={(next) => apply({ outlineColor: next })}
            />
            <EffectNumber
              label="粗细"
              value={effects.outlineWidth}
              min={0}
              max={IMAGE_EFFECT_LIMITS.outlineWidth}
              title="剪影外侧实心环的厚度（逻辑 px）"
              onCommit={(next) => apply({ outlineWidth: next })}
            />
          </div>
          <div className="text-properties__row">
            <EffectNumber
              label="外晕"
              value={effects.outlineGlow}
              min={0}
              max={IMAGE_EFFECT_LIMITS.outlineGlow}
              title="色环之外的柔和扩散（逻辑 px）"
              onCommit={(next) => apply({ outlineGlow: next })}
            />
            <EffectNumber
              label="不透明 %"
              value={Math.round(effects.outlineOpacity * 100)}
              min={0}
              max={100}
              onCommit={(next) => apply({ outlineOpacity: next / 100 })}
            />
          </div>
        </>
      ) : null}

      <h4 className="text-properties__subtitle">发光</h4>
      <div className="text-properties__row text-properties__row--buttons">
        <button
          type="button"
          className={glowOn ? 'is-active' : ''}
          title={glowOn ? '关掉这一张图的发光' : '沿商品轮廓加一圈光环'}
          onClick={() =>
            apply(
              glowOn
                ? { glowOpacity: 0, glowRadius: 0, glowBlur: 0 }
                : { glowOpacity: 0.5, glowRadius: 6, glowBlur: 24 },
            )
          }
        >
          {glowOn ? '发光：开' : '发光：关'}
        </button>
      </div>
      {glowOn ? (
        <>
          <div className="text-properties__row">
            <EffectColor
              label="颜色"
              value={effects.glowColor}
              onCommit={(next) => apply({ glowColor: next })}
            />
            <EffectNumber
              label="硬边"
              value={effects.glowRadius}
              min={0}
              max={IMAGE_EFFECT_LIMITS.glowRadius}
              title="贴着轮廓那一圈的厚度（逻辑 px）"
              onCommit={(next) => apply({ glowRadius: next })}
            />
          </div>
          <div className="text-properties__row">
            <EffectNumber
              label="外晕"
              value={effects.glowBlur}
              min={0}
              max={IMAGE_EFFECT_LIMITS.glowBlur}
              title="硬边之外的柔和扩散（逻辑 px）"
              onCommit={(next) => apply({ glowBlur: next })}
            />
            <EffectNumber
              label="不透明 %"
              value={Math.round(effects.glowOpacity * 100)}
              min={0}
              max={100}
              onCommit={(next) => apply({ glowOpacity: next / 100 })}
            />
          </div>
        </>
      ) : null}

      <div className="text-properties__row text-properties__row--buttons">
        <button
          type="button"
          className="text-properties__reset"
          title="只重置这一张图的效果（不会记住给下一张）"
          onClick={() => onCommit(layer.id, { ...DEFAULT_IMAGE_EFFECTS })}
        >
          重置效果
        </button>
      </div>
      <p className="text-properties__hint">
        效果只作用于这一张图，不会像文字样式那样被下一张继承。
      </p>
    </section>
  );
}
