import { DEFAULT_SERVER_URL } from '../../shared/constants';
import type { AuthUser } from '../../services/server-api';
import { Card } from '../components/Card';
import { Notice } from '../components/Notice';
import { StatusBadge } from '../components/StatusBadge';

export interface AccountSectionProps {
  serverUrl: string;
  onServerUrlChange: (value: string) => void;
  username: string;
  onUsernameChange: (value: string) => void;
  password: string;
  onPasswordChange: (value: string) => void;
  user: AuthUser | null;
  busy: boolean;
  status: string;
  statusKind: 'ok' | 'bad' | 'idle';
  /** 账号/密码表单是否展开。登录成功后默认收起。 */
  formOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
  onLogin: () => void;
  onLogout: () => void;
  onRefresh: () => void;
  lastError: { code: string; message: string; at: number } | null;
  /** 服务地址和已保存的值不同——提示"这里改了但还没提交"。 */
  serverUrlDirty: boolean;
}

/**
 * 账号连接。
 *
 * 展开/收起的判断标准只有一条：**已经登录的人不需要看到密码框**。填完登录一次之后
 * 这里只剩"我在用什么身份、还连得上吗、怎么退出"，重新登录才把表单放回来。
 * 密码任何时候都不回显（输入框 `type=password`，成功后被清空，也不进任何日志）。
 */
export function AccountSection({
  serverUrl,
  onServerUrlChange,
  username,
  onUsernameChange,
  password,
  onPasswordChange,
  user,
  busy,
  status,
  statusKind,
  formOpen,
  onFormOpenChange,
  onLogin,
  onLogout,
  onRefresh,
  lastError,
  serverUrlDirty,
}: AccountSectionProps): JSX.Element {
  const loggedIn = user !== null;
  // 未登录时表单必须显示，否则没法登录；已登录时只有点了「重新登录」才显示。
  const showForm = formOpen || !loggedIn;

  return (
    <Card
      title="账号连接"
      summary={
        <>
          <StatusBadge kind={loggedIn ? 'ok' : 'idle'} label={loggedIn ? '已连接' : '未登录'} />
          {loggedIn ? (
            <span style={{ marginLeft: 8 }}>
              {user.username}
              {user.role ? ` · ${user.role}` : ''}
            </span>
          ) : (
            <span style={{ marginLeft: 8 }}>登录后才能上传素材与回填主图</span>
          )}
        </>
      }
      actions={
        loggedIn && !showForm ? (
          <>
            <button type="button" disabled={busy} onClick={onRefresh}>
              刷新状态
            </button>
            <button type="button" disabled={busy} onClick={() => onFormOpenChange(true)}>
              重新登录
            </button>
            <button type="button" disabled={busy} onClick={onLogout}>
              退出登录
            </button>
          </>
        ) : loggedIn ? (
          <button type="button" disabled={busy} onClick={() => onFormOpenChange(false)}>
            取消
          </button>
        ) : null
      }
    >
      {showForm ? (
        <>
          <div className="opt-grid-2">
            <div className="opt-field">
              <label htmlFor="server-url">服务地址</label>
              <input
                id="server-url"
                value={serverUrl}
                spellCheck={false}
                onChange={(event) => onServerUrlChange(event.target.value)}
                placeholder={DEFAULT_SERVER_URL}
              />
              <small>
                默认 {DEFAULT_SERVER_URL}
                {serverUrlDirty ? '；改完记得到底部点「保存更改」' : '，需要时也可以指向其他同版本服务'}。
              </small>
            </div>
            <div className="opt-field">
              <label htmlFor="username">账号</label>
              <input
                id="username"
                value={username}
                spellCheck={false}
                autoComplete="username"
                onChange={(event) => onUsernameChange(event.target.value)}
              />
            </div>
          </div>

          <div className="opt-field">
            <label htmlFor="password">密码</label>
            <input
              id="password"
              type="password"
              value={password}
              autoComplete="current-password"
              onChange={(event) => onPasswordChange(event.target.value)}
              placeholder="仅用于登录，并保存在本次浏览器会话里用于自动重登"
            />
            <small>密码不写入磁盘，也不显示、不记录在任何日志里。</small>
          </div>

          <div className="opt-actions">
            <button
              type="button"
              className="primary"
              disabled={busy || !username || !password}
              onClick={onLogin}
            >
              {busy ? '正在登录…' : '登录'}
            </button>
            <span className="opt-hint">登录会同时保存服务地址与账号。</span>
          </div>
        </>
      ) : (
        <dl className="opt-kv">
          <dt>服务地址</dt>
          <dd>{serverUrl || DEFAULT_SERVER_URL}</dd>
          <dt>账号</dt>
          <dd>{user?.username ?? '—'}</dd>
          <dt>角色</dt>
          <dd>{user?.role || '—'}</dd>
          <dt>状态</dt>
          <dd>{status || '已登录'}</dd>
        </dl>
      )}

      {statusKind === 'bad' ? (
        <Notice
          kind="error"
          summary={status}
          detailsLabel="查看详情"
          details={`status: ${status}\nserverUrl: ${serverUrl}`}
        />
      ) : null}

      {lastError ? (
        <Notice
          kind="error"
          summary={`最近一次错误：${lastError.message}`}
          details={`code: ${lastError.code}\nat: ${new Date(lastError.at).toLocaleString()}`}
        />
      ) : null}

      <details className="opt-details">
        <summary>技术说明</summary>
        <div className="opt-details__body">
          <p>
            登录：<code>POST /api/admin/auth/login</code>；登录态由服务端下发的 SESSION Cookie 维持。
            退出会同时清掉会话里的密码，下次打开编辑器需要重新登录。
          </p>
          <p>
            上传素材走 <code>POST /api/admin/uploads/images</code>，抠图走{' '}
            <code>POST /api/public/toy-image/v1/background/remove</code>。
          </p>
          <p>密码只存在浏览器的会话存储（chrome.storage.session），浏览器关掉就没了。</p>
        </div>
      </details>
    </Card>
  );
}
