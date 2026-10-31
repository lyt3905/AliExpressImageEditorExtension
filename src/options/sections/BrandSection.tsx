import { useMemo, useState } from 'react';
import type { RefObject } from 'react';
import type { BrandMeta } from '../../shared/types';
import type { BrandCatalogState } from '../../services/brand-catalog/state';
import { Card } from '../components/Card';
import { Drawer } from '../components/Drawer';
import { Notice } from '../components/Notice';
import { Pager } from '../components/Pager';
import { SearchField } from '../components/SearchField';
import { catalogMirrorLabel, formatTimestamp } from '../helpers';

const PAGE_SIZE = 10;

export interface BrandSectionProps {
  brands: BrandMeta[];
  thumbs: Record<string, string>;
  busy: boolean;
  status: { kind: 'ok' | 'bad' | 'idle'; text: string } | null;
  catalog: {
    state: BrandCatalogState | null;
    busy: boolean;
    status: { kind: 'ok' | 'bad' | 'idle'; text: string } | null;
    url: string;
    dirty: boolean;
    onUrlChange: (value: string) => void;
    onSync: () => void;
    /** 把当前注册表导出成 catalog/ 同构的 zip（手工品牌跨机器流通的唯一途径）。 */
    onExport: () => void;
    };
  draft: {
    names: Record<string, string>;
    keywords: Record<string, string>;
    onName: (id: string, value: string) => void;
    onKeywords: (id: string, value: string) => void;
  };
  add: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    name: string;
    onName: (value: string) => void;
    keywords: string;
    onKeywords: (value: string) => void;
    file: File | null;
    onFile: (file: File | null) => void;
    fileInputRef: RefObject<HTMLInputElement>;
    sizeLimitMb: number;
    accept: string;
    onSubmit: () => void;
  };
  edit: {
    id: string | null;
    onOpen: (id: string | null) => void;
    onSave: (id: string) => void;
    onRemove: (meta: BrandMeta) => void;
  };
}

/**
 * 品牌商标。
 *
 * 列表只留六个信息：Logo、名称、关键词（数量 + 单行预览）、来源、同步状态、编辑。
 * 关键词可能长到几十个字，所以单行省略——完整的那份在编辑抽屉里，那里也正是要改它的地方。
 * 目录同步的入口放在列表上方一行，不再出现在每一行里。
 */
export function BrandSection({
  brands,
  thumbs,
  busy,
  status,
  catalog,
  draft,
  add,
  edit,
}: BrandSectionProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [catalogOpen, setCatalogOpen] = useState(false);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return brands;
    return brands.filter(
      (meta) =>
        meta.name.toLowerCase().includes(needle) ||
        (meta.slug ?? '').toLowerCase().includes(needle) ||
        meta.keywords.some((keyword) => keyword.toLowerCase().includes(needle)),
    );
  }, [brands, query]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const editing = edit.id === null ? null : brands.find((meta) => meta.id === edit.id) ?? null;
  const catalogState = catalog.state;
  // 目录来的 vs 手工上传的：手工品牌永远不会被目录同步碰到，所以这里必须分开数，
  // 否则「13 个品牌」看不出另有一批只属于这台机器的。
  const remoteCount = brands.filter((meta) => meta.source === 'remote').length;
  const localCount = brands.length - remoteCount;
  const catalogSummary =
    catalogState === null
      ? '读取中…'
      : catalogState.syncedAt > 0
        ? `已同步 v${catalogState.version} · ${formatTimestamp(catalogState.syncedAt)}${
            catalogState.baseUrlUsed ? ` · ${catalogMirrorLabel(catalogState.baseUrlUsed)}` : ''
          }`
        : '从未同步';

  return (
    <Card
      title="品牌商标"
      summary={
        <>
          <span>
            {brands.length} 个品牌（目录 {remoteCount} / 手工 {localCount}）
          </span>
        </>
      }
      actions={
        <>
          <button type="button" disabled={busy} onClick={() => add.onOpenChange(true)}>
            + 添加品牌
          </button>
        </>
      }
    >
      <div className="opt-row opt-row--muted">
        <div className="opt-row__main">
          <span className="opt-row__title">品牌目录（GitHub）</span>
          <span className="opt-row__sub">
            {catalogState === null ? '读取中…' : catalogSummary}
          </span>
        </div>
        <button type="button" className="opt-link" onClick={() => setCatalogOpen((previous) => !previous)}>
          {catalogOpen ? '收起设置' : '同步设置'}
        </button>
        <button
          type="button"
          disabled={catalog.busy}
          onClick={catalog.onExport}
          title="把当前全部品牌（含手工上传的）导出成 catalog/ 同构的 zip：brands.json + logos/*。传到自己的 HTTPS 空间后，在「自填目录地址」填那个地址，别的客户端同步一次就能拿到手工品牌。"
        >
          导出目录包
        </button>
        <button type="button" className="primary" disabled={catalog.busy} onClick={catalog.onSync}>
          {catalog.busy ? '正在同步…' : '立即同步'}
        </button>
      </div>

      {catalogOpen ? (
        <>
          <div className="opt-field">
            <label htmlFor="catalog-url">自填目录地址（可选）</label>
            <input
              id="catalog-url"
              value={catalog.url}
              spellCheck={false}
              disabled={catalog.busy}
              onChange={(event) => catalog.onUrlChange(event.target.value)}
              placeholder="https://你的域名/catalog/"
            />
            <small>
              国内访问 GitHub 不稳时，把仓库的 catalog/ 镜像到别处再填这里；同步会先试它、失败再回落到
              内置镜像。留空 = 只用内置镜像。只接受 HTTPS（本机 127.0.0.1 可用 HTTP）。
              {catalog.dirty ? ' 改完记得到底部点「保存更改」。' : ''}
            </small>
          </div>
          <p className="opt-hint">
            目录来自仓库的 catalog/brands.json：仓库里加一个品牌、换一张 Logo，这里点一次同步就能拿到，
            不用重新打包插件。打开编辑器时也会自动同步（24 小时内不重复请求）。目录里的品牌 id 固定
            （remote-&lt;slug&gt;），所以更新 Logo 不会让历史画布断图。
          </p>
          <p className="opt-hint">
            <strong>手工上传的品牌只在本机</strong>：它存在这个浏览器配置里，目录同步永远不会碰它，
            所以别的机器看不到。要让它跨机器流通，点上面的「导出目录包」——导出的 zip 与仓库 catalog/
            同构（brands.json + logos/*），传到自己的 HTTPS 空间后，在「自填目录地址」填那个地址，别的
            客户端同步一次就全有了。首次保存/同步该域名时浏览器会问一次「允许访问该网站」，必须点允许，
            否则请求会被直接拦掉。
          </p>
        </>
      ) : (
        <p className="opt-hint opt-hint--tight">
          仓库里的 catalog/brands.json 改完点「立即同步」就能拿到，不用重新打包插件。
        </p>
      )}

      {catalog.status ? (
        <Notice kind={catalog.status.kind === 'bad' ? 'error' : 'ok'} summary={catalog.status.text} />
      ) : null}
      {catalogState?.lastError ? (
        <Notice kind="warn" summary="上次同步失败，当前用的是本地已有的品牌。" details={catalogState.lastError} detailsLabel="查看详情" />
      ) : null}

      <div className="opt-brand-toolbar">
        <SearchField
          value={query}
          label="搜索品牌"
          placeholder="按名称或关键词搜索"
          onChange={(next) => {
            setQuery(next);
            // 搜索结果变了还停在第 3 页，会看到一页空白。
            setPage(0);
          }}
        />
        <span className="opt-hint opt-hint--tight">
          匹配 {filtered.length}/{brands.length}
        </span>
      </div>

      {brands.length === 0 ? (
        <div className="opt-empty">还没有品牌。点右上角「+ 添加品牌」上传一张 Logo 并填上关键词。</div>
      ) : filtered.length === 0 ? (
        <div className="opt-empty">没有匹配「{query}」的品牌。</div>
      ) : (
        <div className="opt-list">
          {visible.map((meta) => {
            const keywords = meta.keywords;
            return (
              <div className="opt-row" key={meta.id}>
                <span className="opt-row__thumb">
                  {thumbs[meta.id] ? (
                    <img src={thumbs[meta.id]} alt="" />
                  ) : (
                    <span className="opt-row__thumb-empty">无图</span>
                  )}
                </span>
                <div className="opt-row__main">
                  <span className="opt-row__title">{meta.name}</span>
                  <span className="opt-row__sub">
                    {keywords.length === 0
                      ? '无关键词（不会自动识别）'
                      : `${keywords.length} 个关键词 · ${keywords.join('、')}`}
                  </span>
                </div>
                <button type="button" disabled={busy} onClick={() => edit.onOpen(meta.id)}>
                  编辑
                </button>
              </div>
            );
          })}
        </div>
      )}

      <Pager page={safePage} pageCount={pageCount} total={filtered.length} unit="个品牌" onChange={setPage} />

      {status ? <Notice kind={status.kind === 'bad' ? 'error' : 'ok'} summary={status.text} /> : null}

      {/* ---- 编辑抽屉 ---- */}
      <Drawer
        open={editing !== null}
        title={editing ? `编辑「${editing.name}」` : '编辑品牌'}
        onClose={() => edit.onOpen(null)}
        footer={
          <>
            {editing ? (
              <button
                type="button"
                className="opt-link opt-link--danger"
                disabled={busy}
                onClick={() => edit.onRemove(editing)}
              >
                删除这个品牌
              </button>
            ) : null}
            <span className="opt-spacer" />
            <button type="button" disabled={busy} onClick={() => edit.onOpen(null)}>
              关闭
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() => {
                if (editing) edit.onSave(editing.id);
              }}
            >
              保存
            </button>
          </>
        }
      >
        {editing ? (
          <>
            <div className="opt-field">
              <label htmlFor="brand-row-name">品牌名称</label>
              <input
                id="brand-row-name"
                value={draft.names[editing.id] ?? editing.name}
                spellCheck={false}
                onChange={(event) => draft.onName(editing.id, event.target.value)}
              />
              <small>只用来区分不同品牌（列表、编辑器里的品牌下拉都显示它），不参与标题匹配。</small>
            </div>
            <div className="opt-field">
              <label htmlFor="brand-row-keywords">标题关键词（逗号分隔）</label>
              <input
                id="brand-row-keywords"
                value={draft.keywords[editing.id] ?? editing.keywords.join(', ')}
                spellCheck={false}
                onChange={(event) => draft.onKeywords(editing.id, event.target.value)}
                placeholder="例：Morph Toys, MTS, 摩变"
              />
              <small>
                标题里出现任一关键词（不区分大小写）就判定为该品牌，所以把品牌名、英文名、系列缩写都写进来。
                留空 = 永不自动识别。
              </small>
            </div>
            <dl className="opt-kv opt-kv--inline">
              <dt>Logo 尺寸</dt>
              <dd>
                {editing.width}×{editing.height}
              </dd>
            </dl>
          </>
        ) : null}
      </Drawer>

      {/* ---- 添加抽屉 ---- */}
      <Drawer
        open={add.open}
        title="添加品牌"
        onClose={() => add.onOpenChange(false)}
        footer={
          <>
            <span className="opt-spacer" />
            <button type="button" disabled={busy} onClick={() => add.onOpenChange(false)}>
              关闭
            </button>
            <button type="button" className="primary" disabled={busy || !add.file} onClick={add.onSubmit}>
              添加品牌
            </button>
          </>
        }
      >
        <div className="opt-field">
          <label htmlFor="brand-file">Logo 图片</label>
          <input
            id="brand-file"
            ref={add.fileInputRef}
            type="file"
            accept={add.accept}
            disabled={busy}
            onChange={(event) => add.onFile(event.target.files?.[0] ?? null)}
          />
          <small>PNG（可带透明通道，推荐）／JPEG／WebP，单张上限 {add.sizeLimitMb}MB。</small>
        </div>
        <div className="opt-field">
          <label htmlFor="brand-name">品牌名称</label>
          <input
            id="brand-name"
            value={add.name}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => add.onName(event.target.value)}
            placeholder="例：Morph Toys"
          />
          <small>只用来区分不同品牌，不参与标题匹配。</small>
        </div>
        <div className="opt-field">
          <label htmlFor="brand-keywords">标题关键词（逗号分隔）</label>
          <input
            id="brand-keywords"
            value={add.keywords}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => add.onKeywords(event.target.value)}
            placeholder="例：Morph Toys, MTS, 摩变"
          />
          <small>
            标题里出现任一关键词（不区分大小写）就判定为该品牌。留空 = 永不自动识别，只能在编辑器里手动选。
          </small>
        </div>
      </Drawer>
    </Card>
  );
}
