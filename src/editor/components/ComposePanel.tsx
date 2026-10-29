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
  /** 识别素材角色 + 排版，一次点击完成（识别在内部，有缓存就不再问模型）。 */
  onGenerate: () => void;
  /** 同一件事的第二档：强制再问一次 AI，然后重排。 */
  onRegenerate: () => void;
  visionBusy: boolean;
  /** Outcome of the last vision attempt, or null. */
  bindNote: string | null;
  /** What the automatic run is doing right now ("等待抠图完成：3/6…"), or null. */
  status: string | null;
  /** What this session reused from the local cache, or null when nothing was. */
  cacheNote: string | null;
  /** True when the current material set already has a finished PNG on disk. */
  hasCachedResult: boolean;
  /** Downloads that PNG instead of generating again. */
  onDownloadCached: () => void;
  /** Forgets every cached cut-out / binding / composed PNG. */
  onClearCache: () => void;
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
  onRegenerate,
  visionBusy,
  bindNote,
  status,
  cacheNote,
  hasCachedResult,
  onDownloadCached,
  onClearCache,
}: ComposePanelProps): JSX.Element {
  /*
    「有没有已抠素材」是唯一的门槛：主体是谁由 AI 认，认不出来才回落到下拉框里
    手动选的那个。所以这里不再要求先有 heroId —— 那会让刚打开面板的人看到一个
    灰掉的按钮，而其实他什么都不缺。
  */
  const ready = cutouts.length > 0;
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

          {/*
            一个按钮做完整件事。识别素材角色是排版的入参，不是独立的步骤 ——
            以前拆成两个按钮，点反顺序就白排一版，而"点完识别还得再点一次生成"
            本来就是实现细节。第二档（强制重问 AI）缩成下面那条小链接，因为它是
            少数情况下才需要的动作。
          */}
          <button
            type="button"
            className="compose-button"
            onClick={onGenerate}
            disabled={busy || !ready}
            title={
              ready
                ? '先用 AI 认出主体与包装盒，再按模板排版并替换当前画布（可撤销）'
                : '需要至少一张已抠素材'
            }
          >
            {busy ? (visionBusy ? '正在识别素材角色…' : '正在排版…') : '生成主图'}
          </button>

          {bindNote ? (
            <button
              type="button"
              className="compose-relink"
              onClick={onRegenerate}
              disabled={busy}
              title="这次会忽略缓存，真的再问一次 AI"
            >
              重新识别素材角色
            </button>
          ) : null}

          {bindNote ? <p className="compose-note compose-note--bind">{bindNote}</p> : null}

          <p className="compose-note">
            打开编辑器会自动生成一次；手动重新生成会替换当前画布（Ctrl+Z 可整体撤销）。
            识别素材角色和排版是同一次点击里的两步，不用分开点。
          </p>

          {/*
            Reuse is worth showing: without this line a fast second visit looks
            identical to a slow one, and 「清除本地缓存」is the only way out when a
            cached cut-out is the thing that looks wrong.
          */}
          {cacheNote ? (
            <div className="compose-cache">
              <p className="compose-note compose-note--cache">{cacheNote}</p>
              {hasCachedResult ? (
                <button
                  type="button"
                  className="compose-cache__clear"
                  onClick={onDownloadCached}
                  disabled={busy}
                  title="直接下载上次生成的 800×800 PNG，不重新排版、不重新抠图"
                >
                  下载缓存成品图
                </button>
              ) : null}
              <button
                type="button"
                className="compose-cache__clear"
                onClick={onClearCache}
                disabled={busy}
                title="删除本机保存的抠图、AI 识别结论和成品图，下次会重新计算"
              >
                清除本地缓存
              </button>
            </div>
          ) : null}
        </section>

        {error ? <div className="notice notice--error">{error}</div> : null}

        {plan && plan.warnings.length > 0 ? (
          <ul className="compose-warnings">
            {plan.warnings.map((entry, index) => (
              <li key={`${entry.code}-${index}`} title={entry.code}>
                {entry.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </aside>
  );
}
