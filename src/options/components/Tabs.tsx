import { useRef } from 'react';
import type { KeyboardEvent } from 'react';

export interface TabItem {
  id: string;
  label: string;
  /** 右侧的小计数（品牌数、水印数…），没有就不显示。 */
  count?: number;
}

export interface TabsProps {
  items: readonly TabItem[];
  active: string;
  onChange: (id: string) => void;
  /** 给 `id`/`aria-controls` 用的前缀，同一个页面里唯一即可。 */
  idPrefix: string;
}

/**
 * 左侧导航（宽屏）/ 顶部标签（窄屏）——同一个组件，方向交给 CSS。
 *
 * 键盘：←→↑↓ 在标签间移动并立即切换，Home/End 跳首尾。这是 WAI-ARIA 对 tablist
 * 的标准行为，"自动激活"是因为四个面板的切换没有任何代价（不重新请求）。
 */
export function Tabs({ items, active, onChange, idPrefix }: TabsProps): JSX.Element {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const activate = (index: number): void => {
    const next = items[(index + items.length) % items.length];
    if (!next) return;
    onChange(next.id);
    refs.current[next.id]?.focus();
  };

  // 只用到 key/preventDefault，所以按元素无关的 HTMLElement 收参数：
  // 监听挂在 <button> 上，div 的键盘事件类型在这里没有意义。
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>, index: number): void => {
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        event.preventDefault();
        activate(index + 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        event.preventDefault();
        activate(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        activate(0);
        break;
      case 'End':
        event.preventDefault();
        activate(items.length - 1);
        break;
      default:
        break;
    }
  };

  return (
    <div className="opt-tabs" role="tablist" aria-label="设置分类" aria-orientation="vertical">
      {items.map((item, index) => {
        const selected = item.id === active;
        return (
          <button
            key={item.id}
            ref={(node) => {
              refs.current[item.id] = node;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${item.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel-${item.id}`}
            // 只有当前标签进 Tab 序列，其余靠方向键——标准 tablist 的焦点管理。
            tabIndex={selected ? 0 : -1}
            className="opt-tabs__item"
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            <span className="opt-tabs__label">{item.label}</span>
            {typeof item.count === 'number' ? <span className="opt-tabs__count">{item.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
