import type { EditorMaterial } from '../../shared/types';
import type { CompositionPlan } from '../../services/composition/planner';
import { DOCUMENT_BACKGROUND_PRESETS } from '../../shared/constants';

export interface ComposeTemplateOption {
  key: string;
  id: string;
  /** 中文名（`TEMPLATE_TITLES`，按 id 记）；下拉框里显示的就是它。 */
  title: string;
  version: string;
  status: string;
}

export interface ComposePanelProps {
  templates: ComposeTemplateOption[];
  templateKey: string;
  onTemplateChange: (key: string) => void;
  /** 画布背景色（文档属性，`#rrggbb`）。 */
  background: string;
  onBackgroundChange: (color: string) => void;
  /**
   * Cut-out materials only: composition works on transparent sources.
   *
   * Used for the "can I generate at all" gate — the material pickers are gone
   * (10.18.4): the roles come from the AI answer, and a seller staring at two
   * dropdowns has no better information than the model does.
   */
  cutouts: EditorMaterial[];
  /**
   * 能手工指定素材的图位（主体 / 包装盒 / 其余图片槽位），顺序即绘制顺序。
   *
   * 10.18.4 删掉的是"生成前先确认主体是谁"那道前置工序；这里是生成之后的修正入口
   * （M3）：AI 认错、或者卖家就是想换张细节图，不该逼他清缓存重来一遍。
   */
  pickSlots: Array<{ slotId: string; label: string; role: string }>;
  /** 当前的手工指定：`slotId -> materialId`，空表 = 全自动。 */
  slotPicks: Record<string, string>;
  /** `null` = 恢复自动（交给 AI / 面积兜底）。 */
  onSlotPick: (slotId: string, materialId: string | null) => void;
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
  background,
  onBackgroundChange,
  cutouts,
  pickSlots,
  slotPicks,
  onSlotPick,
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
  const pickedCount = pickSlots.filter((slot) => (slotPicks[slot.slotId] ?? '') !== '').length;

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
                <option key={template.key} value={template.key} title={template.id}>
                  {template.title} · v{template.version}
                  {template.status === 'draft' ? '（草稿）' : ''}
                </option>
              ))}
            </select>
          </label>

          {/*
            画布背景（10.23.0）：海报模板铺近黑底，白底模板保持 #FFFFFF。

            放在模板下面而不是"图片效果"里，是因为它属于**这张画布**而不是某一层：
            改它是一次可撤销的文档改动，跟着成品缓存键一起变。
          */}
          <div className="compose-field compose-field--background">
            <span>画布背景</span>
            <div className="compose-background">
              <input
                className="compose-background__swatch"
                type="color"
                value={background}
                onChange={(event) => onBackgroundChange(event.target.value)}
                aria-label="画布背景色"
                title="导出 PNG 的底色；不影响水印与品牌图层"
              />
              <div className="compose-background__presets" role="group" aria-label="背景预设">
                {DOCUMENT_BACKGROUND_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    className={`compose-background__preset${background.toLowerCase() === preset.toLowerCase() ? ' compose-background__preset--on' : ''}`}
                    style={{ background: preset }}
                    onClick={() => onBackgroundChange(preset)}
                    title={preset === '#FFFFFF' ? '白底（旧模板的默认）' : preset}
                    aria-label={`背景 ${preset}`}
                  />
                ))}
              </div>
            </div>
          </div>

          {/*
            主体素材 / 包装盒两个下拉框已经去掉（10.18.4）。

            它们是"AI 认不出来时我自己选"的入口，但真正需要它的场合很少：认不出角色
            时标签启发式与面积兜底已经能出图，而卖家看着六个缩略图并没有比模型更多的
            信息。留着它们只会让人以为每次都得先确认一遍"主体是谁"。
            角色仍由 AI 决定，走不通就回落，结论写在下面那条可展开的「识别结论」里。

            10.25.0 补回来的不是那道前置工序，而是**生成之后的修正口**：AI 认错了主体、
            背景挑错了图、细节图该用俯拍那张 —— 这些不需要重新问模型，只需要"这一格
            换成那张图"。所以它默认折叠、只列图位，改一格就按模板重排一次。
          */}
          {pickSlots.length > 0 && cutouts.length > 0 ? (
            <details className="compose-fold compose-fold--picks">
              <summary>
                素材分配（手工指定）
                {pickedCount > 0 ? `：已指定 ${pickedCount} 个图位` : ''}
              </summary>
              <p className="compose-note">
                默认「自动」= 由 AI 决定哪张图放哪个图位。改成具体素材会立刻按模板重排一次
                （不重新问 AI，Ctrl+Z 可整体撤销）；点「自动」恢复交还给 AI。
              </p>
              {pickSlots.map((slot) => (
                <label key={slot.slotId} className="compose-field compose-field--pick">
                  <span>{slot.label}</span>
                  <select
                    className="compose-select"
                    value={slotPicks[slot.slotId] ?? ''}
                    onChange={(event) => onSlotPick(slot.slotId, event.target.value || null)}
                    disabled={busy}
                  >
                    <option value="">自动（AI 决定）</option>
                    {cutouts.map((material) => (
                      <option key={material.id} value={material.id}>
                        {material.label}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              {pickedCount > 0 ? (
                <button
                  type="button"
                  className="compose-cache__clear"
                  onClick={() => pickSlots.forEach((slot) => onSlotPick(slot.slotId, null))}
                  disabled={busy}
                  title="把所有图位交还给 AI 决定，并按模板重排一次"
                >
                  全部恢复自动
                </button>
              ) : null}
            </details>
          ) : null}

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

          {/*
            下面这些东西对"这一次生成"有用，对"平时看一眼"是噪音 —— 识别结论能有
            三行、缓存那行每次都在、让步原因能有五条。默认全部折起来，摘要里只留
            "有什么"，要看就点开。真正需要立刻看到的只有红色报错（在面板下方，不折叠）。
          */}
          {bindNote || cacheNote ? (
            <details className="compose-fold">
              <summary>识别结论与本地缓存</summary>
              {bindNote ? <p className="compose-note compose-note--bind">{bindNote}</p> : null}

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

              <p className="compose-note">
                打开编辑器会自动生成一次；手动重新生成会替换当前画布（Ctrl+Z 可整体撤销）。
                识别素材角色和排版是同一次点击里的两步，不用分开点。
              </p>
            </details>
          ) : null}
        </section>

        {error ? <div className="notice notice--error">{error}</div> : null}

        {/*
          让步原因：五条红字会把面板撑满，而"有没有让步"是摘要就能回答的。
          默认折叠，摘要给出条数与最严重的那条（第一条），点开看全部。
        */}
        {plan && plan.warnings.length > 0 ? (
          <details className="compose-fold compose-fold--warn">
            <summary>
              本次有 {plan.warnings.length} 条让步：{plan.warnings[0]?.message}
            </summary>
            <ul className="compose-warnings">
              {plan.warnings.map((entry, index) => (
                <li key={`${entry.code}-${index}`} title={entry.code}>
                  {entry.message}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </aside>
  );
}
