import type { ReactNode } from 'react';

export type NoticeKind = 'ok' | 'warn' | 'error';

export interface NoticeProps {
  kind: NoticeKind;
  /** 一句人话。错误码、接口路径、堆栈一律进 `details`。 */
  summary: ReactNode;
  /** 折叠起来的完整技术信息；`null`/空串时不渲染折叠面板。 */
  details?: string | null;
  /** 折叠面板的按钮文案，默认「查看详情」。 */
  detailsLabel?: string;
}

/**
 * 提示卡。
 *
 * 以前错误是直接往状态行塞一整段红字，读到第三行就分不清哪句是动作、哪句是原因。
 * 这里固定两层：先说人话，技术细节折在 `<details>` 里（原生元素，键盘可用）。
 */
export function Notice({ kind, summary, details, detailsLabel = '查看详情' }: NoticeProps): JSX.Element {
  const hasDetails = typeof details === 'string' && details.trim().length > 0;
  return (
    <div className={`opt-notice opt-notice--${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <p className="opt-notice__summary">{summary}</p>
      {hasDetails ? (
        <details className="opt-details">
          <summary>{detailsLabel}</summary>
          <div className="opt-details__body">
            <pre>{details}</pre>
          </div>
        </details>
      ) : null}
    </div>
  );
}
