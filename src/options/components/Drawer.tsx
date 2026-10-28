import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export interface DrawerProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * 右侧抽屉：添加 / 编辑品牌、编辑视觉接口。
 *
 * 为什么是抽屉而不是就地展开：这两处都要填四五个字段，就地展开会把列表推走，
 * 位置也在变——点"编辑"之后你找不到自己刚才在看的那一行了。抽屉浮在列表之上，
 * 列表位置不动，编辑完关闭就回到原处。
 *
 * 三个必须做的动作，漏一个抽屉就会"卡住"页面：
 *   1. Esc 关闭（键盘出口）；
 *   2. 打开时把焦点移进抽屉（否则 Tab 还在背后的列表里走）；
 *   3. 关闭时恢复滚动（`overflow: hidden` 不会自己撤销）。
 */
export function Drawer({ open, title, onClose, children, footer }: DrawerProps): JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // 焦点进抽屉：先落到第一个可聚焦元素，没有就落在面板本身（它有 tabIndex=-1）。
    const first = panelRef.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not(.opt-drawer__close)',
    );
    (first ?? panelRef.current)?.focus();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="opt-drawer-scrim" onClick={onClose} role="presentation" />
      <div
        className="opt-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panelRef}
        tabIndex={-1}
      >
        <div className="opt-drawer__head">
          <h3 className="opt-drawer__title">{title}</h3>
          <button
            type="button"
            className="opt-icon-button opt-drawer__close"
            onClick={onClose}
            aria-label="关闭"
            title="关闭（Esc）"
          >
            ✕
          </button>
        </div>
        <div className="opt-drawer__body">{children}</div>
        {footer ? <div className="opt-drawer__foot">{footer}</div> : null}
      </div>
    </>
  );
}
