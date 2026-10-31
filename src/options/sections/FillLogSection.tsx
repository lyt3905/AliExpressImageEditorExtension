import { useState } from 'react';
import type { FillLogEntry } from '../../services/fill-log';
import { Card } from '../components/Card';
import { Notice } from '../components/Notice';
import { Pager } from '../components/Pager';
import { SearchField } from '../components/SearchField';
import { StatusBadge } from '../components/StatusBadge';
import { formatTimestamp } from '../helpers';

const PAGE_SIZE = 10;

export interface FillLogSectionProps {
  entries: readonly FillLogEntry[];
  status: { kind: 'ok' | 'bad' | 'idle'; text: string } | null;
  onClear: () => void;
}

/**
 * 回填记录：哪些商品的主图已经换过。
 *
 * 这一页只读 —— 记录由后台在回填成功时写入（编辑器可能当场关掉，所以不能由它写）。
 * 唯一的操作是清空，因为这是本机账本，不该有人手改一行历史。
 */
export function FillLogSection({ entries, status, onClear }: FillLogSectionProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const keyword = query.trim().toLowerCase();
  const filtered = keyword
    ? entries.filter((entry) =>
        [entry.title, entry.productCode, entry.url].some((field) => field.toLowerCase().includes(keyword)),
      )
    : entries;

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
  const totalFills = entries.reduce((sum, entry) => sum + entry.count, 0);
  const latest = entries[0] ?? null;

  return (
    <Card
      title="回填记录"
      summary={
        entries.length === 0 ? (
          <span>还没有记录</span>
        ) : (
          <span>
            {entries.length} 个商品 · 共 {totalFills} 次 · 最近 {formatTimestamp(latest!.lastAt)}
          </span>
        )
      }
    >
      {entries.length === 0 ? (
        <div className="opt-empty">
          还没有回填记录。在编辑器里点「回填到商品页」成功之后，那个商品会出现在这里 ——
          失败不进这张表（去「账号连接」看错误记录），同一个商品重复回填只累加次数。
        </div>
      ) : (
        <>
          <div className="opt-brand-toolbar">
            <SearchField
              value={query}
              onChange={(value) => {
                setQuery(value);
                setPage(0);
              }}
              label="搜索商品标题、编号或地址"
              placeholder="搜索标题 / 编号 / 地址"
            />
            <button type="button" className="opt-link opt-link--danger" onClick={onClear}>
              清空记录
            </button>
          </div>

          {filtered.length === 0 ? (
            <div className="opt-empty">没有匹配「{query.trim()}」的记录。</div>
          ) : (
            <div className="opt-list">
              {visible.map((entry) => (
                <div className="opt-row opt-row--log" key={entry.key}>
                  <div className="opt-row__main">
                    <span className="opt-row__title" title={entry.title || entry.url}>
                      {entry.title || '（没有标题）'}
                    </span>
                    <span className="opt-row__sub">
                      {entry.productCode ? `编号 ${entry.productCode}` : '无编号'}
                      {entry.count > 1 ? ` · 回填 ${entry.count} 次` : ''}
                    </span>
                  </div>
                  <span className="opt-row__meta">{formatTimestamp(entry.lastAt)}</span>
                  {entry.status === 'success' ? (
                    <StatusBadge kind="ok" label="已回填" />
                  ) : (
                    <StatusBadge kind="warn" label="未确认" title="图已进面板，但没等到服务端完成信号 —— 值得去商品页看一眼" />
                  )}
                  <span className="opt-row__actions">
                    <a className="opt-link" href={entry.url} target="_blank" rel="noreferrer noopener">
                      打开
                    </a>
                  </span>
                </div>
              ))}
            </div>
          )}

          <Pager page={safePage} pageCount={pageCount} total={filtered.length} unit="条记录" onChange={setPage} />
        </>
      )}

      {status ? <Notice kind={status.kind === 'bad' ? 'error' : 'ok'} summary={status.text} /> : null}
    </Card>
  );
}
