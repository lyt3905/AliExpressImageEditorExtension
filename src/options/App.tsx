import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_SERVER_URL } from '../shared/constants';
import { messageOf } from '../shared/errors';
import { createRequestId, sendToBackground } from '../shared/messages';
import type { AuthUser } from '../services/server-api';
import type { ExtensionSettings } from '../services/settings';

const LAST_ERROR_KEY = 'aiee:last-error';

interface LastError {
  code: string;
  message: string;
  at: number;
}

export function OptionsApp(): JSX.Element {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<string>('');
  const [statusKind, setStatusKind] = useState<'ok' | 'bad' | 'idle'>('idle');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [lastError, setLastError] = useState<LastError | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshAuthState = useCallback(async () => {
    try {
      const response = await sendToBackground<{ loggedIn: boolean; user: AuthUser | null }>({
        type: 'GET_AUTH_STATE',
        requestId: createRequestId('auth'),
      });
      if (response?.ok && response.data) {
        setUser(response.data.user);
        return response.data.loggedIn;
      }
    } catch {
      /* ignore */
    }
    setUser(null);
    return false;
  }, []);

  useEffect(() => {
    void (async () => {
      const response = await sendToBackground<ExtensionSettings>({
        type: 'GET_SETTINGS',
        requestId: createRequestId('settings'),
      });
      if (response?.ok && response.data) {
        setServerUrl(response.data.serverUrl);
        setUsername(response.data.username);
      }
      const loggedIn = await refreshAuthState();
      setStatus(loggedIn ? '已登录' : '未登录（账号会保存在浏览器会话中，用于自动重新登录）');
      setStatusKind(loggedIn ? 'ok' : 'idle');

      try {
        const stored = await chrome.storage.local.get(LAST_ERROR_KEY);
        const value = stored?.[LAST_ERROR_KEY] as LastError | undefined;
        if (value) setLastError(value);
      } catch {
        /* ignore */
      }
    })();
  }, [refreshAuthState]);

  const handleLogin = useCallback(async () => {
    setBusy(true);
    setStatus('正在登录…');
    setStatusKind('idle');
    try {
      const response = await sendToBackground<AuthUser>({
        type: 'LOGIN',
        requestId: createRequestId('login'),
        payload: { serverUrl, username, password },
      });
      if (!response?.ok) {
        setStatus(`登录失败：${response?.error?.message ?? '未知错误'}`);
        setStatusKind('bad');
        return;
      }
      setUser(response.data ?? null);
      setStatus(`登录成功${response.data?.username ? `：${response.data.username}` : ''}`);
      setStatusKind('ok');
      setPassword('');
    } catch (error) {
      setStatus(`登录失败：${messageOf(error)}`);
      setStatusKind('bad');
    } finally {
      setBusy(false);
    }
  }, [password, serverUrl, username]);

  const handleLogout = useCallback(async () => {
    setBusy(true);
    try {
      await sendToBackground({ type: 'LOGOUT', requestId: createRequestId('logout') });
      setUser(null);
      setPassword('');
      setStatus('已退出登录');
      setStatusKind('idle');
    } finally {
      setBusy(false);
    }
  }, []);

  const handleSave = useCallback(async () => {
    setBusy(true);
    try {
      const response = await sendToBackground<ExtensionSettings>({
        type: 'SAVE_SETTINGS',
        requestId: createRequestId('save'),
        payload: { serverUrl, username, ...(password ? { password } : {}) },
      });
      if (response?.ok) {
        setStatus('设置已保存');
        setStatusKind('ok');
      } else {
        setStatus(`保存失败：${response?.error?.message ?? '未知错误'}`);
        setStatusKind('bad');
      }
    } finally {
      setBusy(false);
    }
  }, [password, serverUrl, username]);

  return (
    <div className="options">
      <h1>AliExpress 图片编辑器 · 设置</h1>
      <p className="hint">
        抠图使用服务端已有接口（<code>POST /api/admin/uploads/images</code> 上传 →{' '}
        <code>POST /api/public/toy-image/v1/background/remove</code> 抠图）。登录态由服务端下发的 SESSION Cookie
        维持；密码不会写入磁盘，仅保存在浏览器会话存储中用于自动重新登录。
      </p>

      <div className="field">
        <label htmlFor="server-url">服务地址</label>
        <input
          id="server-url"
          value={serverUrl}
          spellCheck={false}
          onChange={(event) => setServerUrl(event.target.value)}
          placeholder={DEFAULT_SERVER_URL}
        />
        <small>默认 {DEFAULT_SERVER_URL}，可在需要时指向其他同版本服务。</small>
      </div>

      <div className="field">
        <label htmlFor="username">账号</label>
        <input
          id="username"
          value={username}
          spellCheck={false}
          autoComplete="username"
          onChange={(event) => setUsername(event.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="password">密码</label>
        <input
          id="password"
          type="password"
          value={password}
          autoComplete="current-password"
          onChange={(event) => setPassword(event.target.value)}
          placeholder="仅用于登录与本次浏览器会话内的自动重登"
        />
      </div>

      <div className="row">
        <button type="button" className="primary" disabled={busy || !username || !password} onClick={() => void handleLogin()}>
          登录并保存
        </button>
        <button type="button" disabled={busy} onClick={() => void handleSave()}>
          仅保存设置
        </button>
        <button type="button" disabled={busy} onClick={() => void refreshAuthState()}>
          刷新登录状态
        </button>
        <button type="button" disabled={busy} onClick={() => void handleLogout()}>
          退出登录
        </button>
      </div>

      <div className="status-line">
        <div>
          登录状态：
          <strong className={statusKind === 'ok' ? 'status-ok' : statusKind === 'bad' ? 'status-bad' : ''}>
            {user ? `${user.username}${user.role ? ` · ${user.role}` : ''}` : status || '未登录'}
          </strong>
        </div>
        {user ? null : <div>{status}</div>}
        {lastError ? (
          <div>
            最近一次错误：<span className="status-bad">[{lastError.code}] {lastError.message}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
