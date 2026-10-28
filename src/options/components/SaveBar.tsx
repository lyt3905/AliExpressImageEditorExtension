import { StatusBadge } from './StatusBadge';
import type { BadgeKind } from './StatusBadge';

export interface SaveBarStatus {
  kind: 'ok' | 'bad' | 'idle';
  text: string;
}

export interface SaveBarProps {
  /** 表单里有没有还没写进存储的改动。没有就是禁用状态。 */
  dirty: boolean;
  busy: boolean;
  status: SaveBarStatus | null;
  onSave: () => void;
  onReset: () => void;
}

/**
 * 底部统一的保存区。
 *
 * 之前页面上有四个保存按钮（登录并保存 / 仅保存设置 / 保存视觉设置 / 隐蔽的目录地址），
 * 谁也说不清"我改的那一项到底该点哪个"。现在只剩一个提交点：没改动时它是灰的，
 * 改动后变蓝，保存完回到灰——按钮颜色本身就是"存没存"的答案。
 */
export function SaveBar({ dirty, busy, status, onSave, onReset }: SaveBarProps): JSX.Element {
  const badge: BadgeKind = status ? (status.kind === 'idle' ? 'info' : status.kind) : 'warn';
  return (
    <footer className="opt-savebar">
      <div className="opt-savebar__inner">
        <div className="opt-savebar__status" aria-live="polite">
          {status ? (
            <StatusBadge kind={badge} label={status.text} />
          ) : dirty ? (
            <>
              <StatusBadge kind="warn" label="有未保存的修改" />
              <span>切换分类不会丢，关掉这个页面就没了。</span>
            </>
          ) : (
            <span>没有未保存的修改。</span>
          )}
        </div>
        <div className="opt-savebar__actions">
          <button type="button" onClick={onReset} disabled={!dirty || busy}>
            放弃修改
          </button>
          <button type="button" className="primary" onClick={onSave} disabled={!dirty || busy}>
            {busy ? '正在保存…' : '保存更改'}
          </button>
        </div>
      </div>
    </footer>
  );
}
