import type { EditorMaterial } from '../../shared/types';
import type { CompositionPlan } from '../../services/composition/planner';

export interface ComposeTemplateOption {
  key: string;
  id: string;
  version: string;
  status: string;
}

export interface ComposePanelProps {
  templates: ComposeTemplateOption[];
  templateKey: string;
  onTemplateChange: (key: string) => void;
  /** Cut-out materials only: composition works on transparent sources. */
  cutouts: EditorMaterial[];
  heroId: string | null;
  boxId: string | null;
  onHeroChange: (materialId: string) => void;
  onBoxChange: (materialId: string | null) => void;
  busy: boolean;
  plan: CompositionPlan | null;
  error: string | null;
  onGenerate: () => void;
  /** Runs the vision model to decide hero/box; explicit, never automatic. */
  onVisionBind: () => void;
  visionBusy: boolean;
  /** Outcome of the last vision attempt, or null. */
  bindNote: string | null;
  /** What the automatic run is doing right now ("等待抠图完成：3/6…"), or null. */
  status: string | null;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function ComposePanel({
  templates,
  templateKey,
  onTemplateChange,
  cutouts,
  heroId,
  boxId,
  onHeroChange,
  onBoxChange,
  busy,
  plan,
  error,
  onGenerate,
  onVisionBind,
  visionBusy,
  bindNote,
  status,
}: ComposePanelProps): JSX.Element {
  const ready = cutouts.length > 0 && Boolean(heroId);
  const active = templates.find((template) => template.key === templateKey);

  return (
    <aside className="panel compose-panel">
      <div className="panel__title">
        <span>智能排版</span>
        <span className="toolbar__hint">{active ? `v${active.version}` : ''}</span>
      </div>
      <div className="panel__body">
        {/*
          The automatic run spends most of its time waiting for cut-outs, so this line
          is the answer to "程序现在在做什么". `role="status"` makes it announce the
          counters as they change, which is the only progress feedback in the panel.
        */}
        {status ? (
          <p className="compose-status" role="status" aria-live="polite">
            {status}
          </p>
        ) : null}

        <section className="panel__group">
          <label className="compose-field">
            <span>版式模板</span>
            <select
              className="compose-select"
              value={templateKey}
              onChange={(event) => onTemplateChange(event.target.value)}
              disabled={busy}
            >
              {templates.map((template) => (
                <option key={template.key} value={template.key}>
                  {template.id} · v{template.version}
                  {template.status === 'draft' ? '（草稿）' : ''}
                </option>
              ))}
            </select>
          </label>

          <label className="compose-field">
            <span>主体素材</span>
            <select
              className="compose-select"
              value={heroId ?? ''}
              onChange={(event) => onHeroChange(event.target.value)}
              disabled={busy || cutouts.length === 0}
            >
              {cutouts.length === 0 ? <option value="">暂无已抠素材</option> : null}
              {cutouts.map((material) => (
                <option key={material.id} value={material.id}>
                  {material.label}
                </option>
              ))}
            </select>
          </label>

          <label className="compose-field">
            <span>包装盒</span>
            <select
              className="compose-select"
              value={boxId ?? ''}
              onChange={(event) => onBoxChange(event.target.value || null)}
              disabled={busy || cutouts.length === 0}
            >
              <option value="">无（按兜底规则留空/换图）</option>
              {cutouts
                .filter((material) => material.id !== heroId)
                .map((material) => (
                  <option key={material.id} value={material.id}>
                    {material.label}
                  </option>
                ))}
            </select>
          </label>

          <button
            type="button"
            className="compose-button compose-button--secondary"
            onClick={onVisionBind}
            disabled={busy || visionBusy || cutouts.length === 0}
            title="把前几张素材发给视觉模型，由它判断谁是主体、谁是包装盒"
          >
            {visionBusy ? 'AI 识别中…' : 'AI 识别素材角色'}
          </button>

          {bindNote ? <p className="compose-note compose-note--bind">{bindNote}</p> : null}

          <button
            type="button"
            className="compose-button"
            onClick={onGenerate}
            disabled={busy || !ready}
            title={ready ? '按模板排版并替换当前画布（可撤销）' : '需要至少一张已抠素材'}
          >
            {busy ? '正在排版…' : '生成主图'}
          </button>
          <p className="compose-note">
            打开编辑器会自动生成一次；手动重新生成会替换当前画布（Ctrl+Z 可整体撤销）。
          </p>
        </section>

        {error ? <div className="notice notice--error">{error}</div> : null}

        {plan ? (
          <section className="panel__group">
            <h3 className="panel__group-title">
              <span>本次结果</span>
              <span>{plan.templateId}</span>
            </h3>
            <dl className="compose-diagnostics">
              <dt>主体</dt>
              <dd>
                zoom {plan.diagnostics.heroNominalZoom} → {plan.diagnostics.heroZoom}
                {'，'}可见占比 {percent(plan.diagnostics.heroOccupancy)}
              </dd>
              <dt>包装盒</dt>
              <dd>
                {plan.diagnostics.boxVariantIndex === null
                  ? '未放置'
                  : `变体 #${plan.diagnostics.boxVariantIndex}，可见 ${
                      plan.diagnostics.boxVisibleRatio === null
                        ? '—'
                        : percent(plan.diagnostics.boxVisibleRatio)
                    }`}
              </dd>
              <dt>兜底</dt>
              <dd>{plan.diagnostics.boxFallback}</dd>
              <dt>编号</dt>
              <dd>{plan.texts.length > 0 ? `${plan.texts[0].fontSize}px` : '无'}</dd>
            </dl>

            {plan.warnings.length > 0 ? (
              <ul className="compose-warnings">
                {plan.warnings.map((entry, index) => (
                  <li key={`${entry.code}-${index}`} title={entry.code}>
                    {entry.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="compose-note">没有让步，按模板原始数值排版。</p>
            )}
          </section>
        ) : null}
      </div>
    </aside>
  );
}
