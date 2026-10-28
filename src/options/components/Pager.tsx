export interface PagerProps {
  /** 0 起的目标页。 */
  page: number;
  pageCount: number;
  total: number;
  /** 单位，用于「共 13 个品牌」这句。 */
  unit: string;
  onChange: (page: number) => void;
}

/**
 * 分页。品牌从 13 个起就说明这个列表会一直长下去；一个没有高度上限的列表
 * 会把后面的卡片挤出屏幕，也会让人以为"到底了"。
 */
export function Pager({ page, pageCount, total, unit, onChange }: PagerProps): JSX.Element | null {
  if (pageCount <= 1) {
    return <div className="opt-pager">共 {total} {unit}</div>;
  }
  return (
    <div className="opt-pager">
      <span>
        共 {total} {unit} · 第 {page + 1}/{pageCount} 页
      </span>
      <div className="opt-pager__buttons">
        <button type="button" disabled={page <= 0} onClick={() => onChange(page - 1)}>
          上一页
        </button>
        <button type="button" disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  );
}
