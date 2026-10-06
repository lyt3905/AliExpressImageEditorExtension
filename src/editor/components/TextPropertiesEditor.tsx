/**
 * Properties panel for the selected text layer.
 *
 * Every control produces exactly ONE history step: the free-form inputs commit
 * on blur, the discrete ones (font family, bold, align, presets) on click. That
 * is what keeps undo meaningful — typing "Summer Sale" must not create eleven
 * entries, and dragging around inside a colour picker must not create fifty.
 *
 * Nothing here talks to storage either: the layer lives in the editor document
 * like any picture layer, and remembering the style is `App`'s job. This
 * component only ever reports patches.
 */

import { useEffect, useState } from 'react';
import {
  MAX_FONT_SIZE,
  MAX_SHADOW_BLUR,
  MAX_SHADOW_OFFSET,
  MAX_STROKE_WIDTH,
  MIN_FONT_SIZE,
  MIN_SHADOW_BLUR,
  MIN_SHADOW_OFFSET,
  MIN_STROKE_WIDTH,
  TEXT_FONT_FAMILIES,
} from '../../shared/constants';
import type { LayerPatch, TextLayer } from '../../shared/types';

const ALIGN_OPTIONS: readonly TextLayer['align'][] = ['left', 'center', 'right'];

const ALIGN_LABEL: Record<TextLayer['align'], string> = {
  left: '左',
  center: '中',
  right: '右',
};

const ALIGN_TITLE: Record<TextLayer['align'], string> = {
  left: '左对齐',
  center: '居中',
  right: '右对齐',
};

/** A preset is just a patch, so applying one costs exactly one history step. */
interface Preset {
  label: string;
  patch: LayerPatch;
}

const STROKE_PRESETS: readonly Preset[] = [
  { label: '无', patch: { strokeWidth: 0 } },
  { label: '白描边', patch: { stroke: '#ffffff', strokeWidth: 4 } },
  { label: '黑描边', patch: { stroke: '#000000', strokeWidth: 4 } },
];

const SHADOW_PRESETS: readonly Preset[] = [
  { label: '无', patch: { shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0 } },
  {
    label: '投影',
    patch: { shadowColor: '#000000', shadowBlur: 8, shadowOffsetX: 0, shadowOffsetY: 6, shadowOpacity: 0.5 },
  },
  {
    label: '柔和',
    patch: { shadowColor: '#000000', shadowBlur: 24, shadowOffsetX: 0, shadowOffsetY: 0, shadowOpacity: 0.35 },
  },
  {
    label: '发光',
    patch: { shadowColor: '#ffd400', shadowBlur: 22, shadowOffsetX: 0, shadowOffsetY: 0, shadowOpacity: 0.9 },
  },
];

/** True when every field the preset sets already matches the layer. */
function presetMatches(layer: TextLayer, patch: LayerPatch): boolean {
  return Object.entries(patch).every(
    ([key, value]) => (layer as unknown as Record<string, unknown>)[key] === value,
  );
}

interface NumberFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  title?: string;
  onCommit: (next: number) => void;
}

/**
 * Number input that keeps a local draft and commits once, on blur / Enter.
 *
 * Committing per keystroke is what would flood the undo stack: typing "48" goes
 * through "4" first.
 */
function NumberField({ label, value, min, max, title, onCommit }: NumberFieldProps): JSX.Element {
  const [draft, setDraft] = useState(String(value));

  // Re-sync after undo / redo, or when a different layer gets selected.
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    const next =
      draft.trim() !== '' && Number.isFinite(parsed)
        ? Math.min(max, Math.max(min, Math.round(parsed)))
        : value;
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

interface ColorFieldProps {
  label: string;
  value: string;
  title?: string;
  onCommit: (next: string) => void;
}

/** Same draft-then-blur rule as `NumberField`; a picker fires `input` continuously. */
function ColorField({ label, value, title, onCommit }: ColorFieldProps): JSX.Element {
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

export interface TextPropertiesEditorProps {
  layer: TextLayer;
  onCommit: (layerId: string, patch: LayerPatch) => void;
  /** Applied to the layer *and* to the remembered preference. */
  onResetStyle: (layerId: string) => void;
}

export function TextPropertiesEditor({
  layer,
  onCommit,
  onResetStyle,
}: TextPropertiesEditorProps): JSX.Element {
  // Only the textarea needs a parent-level draft; every other input owns its own.
  const [draftText, setDraftText] = useState(layer.text);

  useEffect(() => {
    setDraftText(layer.text);
  }, [layer.id, layer.text]);

  const commitText = () => {
    if (draftText !== layer.text) onCommit(layer.id, { text: draftText });
  };

  const patch = (next: LayerPatch) => onCommit(layer.id, next);

  const renderPresets = (presets: readonly Preset[]) => (
    <div className="text-properties__row text-properties__row--buttons">
      {presets.map((preset) => (
        <button
          key={preset.label}
          type="button"
          className={presetMatches(layer, preset.patch) ? 'is-active' : ''}
          onClick={() => patch(preset.patch)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );

  return (
    <section className="text-properties">
      <h3 className="panel__group-title">
        <span>文字属性</span>
        <span>{layer.text.length} 字</span>
      </h3>

      <label className="text-properties__field">
        <span>文字内容</span>
        <textarea
          rows={3}
          spellCheck={false}
          value={draftText}
          placeholder="输入文字，支持换行"
          onChange={(event) => setDraftText(event.target.value)}
          onBlur={commitText}
        />
      </label>

      <label className="text-properties__field">
        <span>字体</span>
        <select
          value={layer.fontFamily}
          onChange={(event) => patch({ fontFamily: event.target.value })}
        >
          {TEXT_FONT_FAMILIES.map((family) => (
            <option key={family} value={family}>
              {family}
            </option>
          ))}
        </select>
      </label>

      <div className="text-properties__row">
        <NumberField
          label="字号"
          value={layer.fontSize}
          min={MIN_FONT_SIZE}
          max={MAX_FONT_SIZE}
          onCommit={(next) => patch({ fontSize: next })}
        />
        <ColorField label="颜色" value={layer.fill} onCommit={(next) => patch({ fill: next })} />
      </div>

      <div className="text-properties__row text-properties__row--buttons">
        <button
          type="button"
          className={layer.fontStyle === 'bold' ? 'is-active' : ''}
          title="加粗"
          onClick={() => patch({ fontStyle: layer.fontStyle === 'bold' ? 'normal' : 'bold' })}
        >
          B
        </button>
        {ALIGN_OPTIONS.map((align) => (
          <button
            key={align}
            type="button"
            className={layer.align === align ? 'is-active' : ''}
            title={ALIGN_TITLE[align]}
            onClick={() => patch({ align })}
          >
            {ALIGN_LABEL[align]}
          </button>
        ))}
      </div>

      <h4 className="text-properties__subtitle">描边</h4>
      {renderPresets(STROKE_PRESETS)}
      <div className="text-properties__row">
        <ColorField
          label="描边颜色"
          value={layer.stroke}
          title="宽度为 0 时不生效"
          onCommit={(next) => patch({ stroke: next })}
        />
        <NumberField
          label="宽度"
          value={layer.strokeWidth}
          min={MIN_STROKE_WIDTH}
          max={MAX_STROKE_WIDTH}
          title={`0–${MAX_STROKE_WIDTH}，0 表示无描边`}
          onCommit={(next) => patch({ strokeWidth: next })}
        />
      </div>

      <h4 className="text-properties__subtitle">阴影</h4>
      {renderPresets(SHADOW_PRESETS)}
      <div className="text-properties__row">
        <ColorField
          label="阴影颜色"
          value={layer.shadowColor}
          title="模糊和偏移都为 0 时不生效"
          onCommit={(next) => patch({ shadowColor: next })}
        />
        <NumberField
          label="模糊"
          value={layer.shadowBlur}
          min={MIN_SHADOW_BLUR}
          max={MAX_SHADOW_BLUR}
          onCommit={(next) => patch({ shadowBlur: next })}
        />
      </div>
      <div className="text-properties__row">
        <NumberField
          label="水平偏移"
          value={layer.shadowOffsetX}
          min={MIN_SHADOW_OFFSET}
          max={MAX_SHADOW_OFFSET}
          onCommit={(next) => patch({ shadowOffsetX: next })}
        />
        <NumberField
          label="垂直偏移"
          value={layer.shadowOffsetY}
          min={MIN_SHADOW_OFFSET}
          max={MAX_SHADOW_OFFSET}
          onCommit={(next) => patch({ shadowOffsetY: next })}
        />
      </div>
      <div className="text-properties__row">
        <NumberField
          label="不透明度 %"
          value={Math.round(layer.shadowOpacity * 100)}
          min={0}
          max={100}
          onCommit={(next) => patch({ shadowOpacity: next / 100 })}
        />
      </div>

      <div className="text-properties__row text-properties__row--buttons">
        <button
          type="button"
          className="text-properties__reset"
          title="把当前文字恢复为默认样式，并清除「新建文字沿用上次样式」的记忆"
          onClick={() => onResetStyle(layer.id)}
        >
          恢复默认样式
        </button>
      </div>

      <p className="text-properties__hint">
        内容 / 字号 / 颜色 / 描边 / 阴影改完后点击空白处生效；描边和阴影会跟着文字一起放大。
        用拖拽手柄缩放文字会折算成字号，所以这里的数字会跟着你拖的大小一起变。
        样式（字号、字体、颜色、粗细、对齐、描边、阴影）会被记住，下次添加文字直接沿用；
        文字内容、位置、旋转、镜像不记，字号最多记到 200 上限。
      </p>
    </section>
  );
}
