import type { ReactNode } from 'react';

export interface CardProps {
  title: string;
  /** 标题右侧的一句话摘要：不用展开就能判断"这里是不是对的"。 */
  summary?: ReactNode;
  /** 摘要右边的主/次操作。 */
  actions?: ReactNode;
  children?: ReactNode;
}

/**
 * 一张分区卡：标题行 + 内容。
 *
 * 设置页以前是 `<h2>` + 一堆平铺字段，滚动时看不出"哪几行属于同一件事"。
 * 卡片把边界画出来，标题行顺带承担摘要——收起状态下也能读到关键值。
 */
export function Card({ title, summary, actions, children }: CardProps): JSX.Element {
  return (
    <section className="opt-card">
      <div className="opt-card__head">
        <h2 className="opt-card__title">{title}</h2>
        <div className="opt-card__summary">{summary}</div>
        {actions ? <div className="opt-card__actions">{actions}</div> : null}
      </div>
      <div className="opt-card__body">{children}</div>
    </section>
  );
}
