import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SERVER_URL, MAX_WATERMARK_BYTES } from '../shared/constants';
import { messageOf } from '../shared/errors';
import { createRequestId, sendToBackground } from '../shared/messages';
import type { WatermarkMeta } from '../shared/types';
import type { AuthUser } from '../services/server-api';
import type { ExtensionSettings } from '../services/settings';
import {
  listWatermarks,
  loadWatermarkBlob,
  removeWatermark,
  renameWatermark,
  saveWatermark,
  setDefaultWatermark,
} from '../services/watermark-store';

const LAST_ERROR_KEY = 'aiee:last-error';
const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp';
const SIZE_LIMIT_MB = Math.round(MAX_WATERMARK_BYTES / 1024 / 1024);

interface LastError {
  code: string;
  message: string;
  at: number;
}

type StatusKind = 'ok' | 'bad' | 'idle';

export function OptionsApp(): JSX.Element {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<string>('');
  const [statusKind, setStatusKind] = useState<StatusKind>('idle');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [lastError, setLastError] = useState<LastError | null>(null);
  const [busy, setBusy] = useState(false);

  const [watermarks, setWatermarks] = useState<WatermarkMeta[]>([]);
  const [watermarkNames, setWatermarkNames] = useState<Record<string, string>>({});
  const [watermarkThumbs, setWatermarkThumbs] = useState<Record<string, string>>({});
  const [watermarkStatus, setWatermarkStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [watermarkBusy, setWatermarkBusy] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const thumbUrlsRef = useRef<Record<string, string>>({});

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

  const refreshWatermarks = useCallback(async (): Promise<WatermarkMeta[]> => {
    const list = await listWatermarks();
    setWatermarks(list);
    setWatermarkNames(Object.fromEntries(list.map((entry) => [entry.id, entry.name])));
    return list;
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

  useEffect(() => {
    void refreshWatermarks();
  }, [refreshWatermarks]);

  // ---- thumbnail object URLs for the watermark list
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const meta of watermarks) {
        if (thumbUrlsRef.current[meta.id]) continue;
        const blob = await loadWatermarkBlob(meta);
        if (!blob || cancelled) continue;
        const url = URL.createObjectURL(blob);
        thumbUrlsRef.current[meta.id] = url;
        if (!cancelled) setWatermarkThumbs((previous) => ({ ...previous, [meta.id]: url }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [watermarks]);

  useEffect(
    () => () => {
      for (const url of Object.values(thumbUrlsRef.current)) URL.revokeObjectURL(url);
      thumbUrlsRef.current = {};
    },
    [],
  );

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

  // ---- watermark management

  const handleAddWatermark = useCallback(
    async (file: File | undefined) => {
      if (!file) return;
      setWatermarkBusy(true);
      setWatermarkStatus({ kind: 'idle', text: `正在添加 ${file.name}…` });
      try {
        const meta = await saveWatermark(file, file.name.replace(/\.[^.]+$/, ''));
        await refreshWatermarks();
        setWatermarkStatus({
          kind: 'ok',
          text: `已添加「${meta.name}」${meta.isDefault ? '，并自动设为默认水印' : ''}`,
        });
      } catch (error) {
        setWatermarkStatus({ kind: 'bad', text: messageOf(error) });
      } finally {
        setWatermarkBusy(false);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    },
    [refreshWatermarks],
  );

  const handleRenameWatermark = useCallback(
    async (id: string) => {
      const draft = watermarkNames[id];
      const meta = watermarks.find((entry) => entry.id === id);
      if (!draft || !meta || draft === meta.name) return;
      setWatermarks(await renameWatermark(id, draft));
    },
    [watermarkNames, watermarks],
  );

  const handleSetDefaultWatermark = useCallback(async (id: string) => {
    setWatermarks(await setDefaultWatermark(id));
    setWatermarkStatus({ kind: 'ok', text: '已设为默认水印（下次打开编辑器生效）' });
  }, []);

  const handleRemoveWatermark = useCallback(
    async (meta: WatermarkMeta) => {
      if (!window.confirm(`确定删除水印「${meta.name}」吗？该操作不可撤销。`)) return;
      const cached = thumbUrlsRef.current[meta.id];
      if (cached) {
        URL.revokeObjectURL(cached);
        delete thumbUrlsRef.current[meta.id];
      }
      setWatermarkThumbs((previous) => {
        const next = { ...previous };
        delete next[meta.id];
        return next;
      });
      setWatermarks(await removeWatermark(meta.id));
      setWatermarkStatus({ kind: 'ok', text: `已删除「${meta.name}」` });
    },
    [],
  );

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

      <hr className="section-divider" />

      <h2>水印框</h2>
      <p className="hint">
        可以配置多个水印框，并把其中一个设为默认。每次打开编辑器时，默认水印会自动作为
        <strong>锁定图层放在最上层</strong>——不可拖动、缩放、旋转、删除，也不受「清空画布 / 撤销」影响，
        导出时一并合成。编辑器工具栏里可以临时隐藏或换用其他水印，不会改变这里的默认设置。
      </p>

      <div className="field">
        <label htmlFor="watermark-file">添加水印框</label>
        <input
          id="watermark-file"
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          disabled={watermarkBusy}
          onChange={(event) => void handleAddWatermark(event.target.files?.[0])}
        />
        <small>
          PNG（可带透明通道，推荐）／JPEG／WebP，单张上限 {SIZE_LIMIT_MB}MB。
          图片按「长边铺满 800、居中」等比缩放，不拉伸；边框类水印请直接做成正方形。
        </small>
      </div>

      {watermarks.length === 0 ? (
        <div className="empty">还没有水印框，添加一张即可自动成为默认水印。</div>
      ) : (
        <div className="watermark-list">
          {watermarks.map((meta) => (
            <div className="watermark-row" key={meta.id}>
              <span className="watermark-row__thumb">
                {watermarkThumbs[meta.id] ? (
                  <img src={watermarkThumbs[meta.id]} alt="" />
                ) : (
                  <span className="watermark-row__thumb-empty" />
                )}
              </span>

              <input
                className="watermark-row__name"
                value={watermarkNames[meta.id] ?? meta.name}
                spellCheck={false}
                onChange={(event) =>
                  setWatermarkNames((previous) => ({ ...previous, [meta.id]: event.target.value }))
                }
                onBlur={() => void handleRenameWatermark(meta.id)}
              />

              <span className="watermark-row__size">
                {meta.width}×{meta.height}
              </span>

              <label className="watermark-row__default" title="设为默认水印">
                <input
                  type="radio"
                  name="watermark-default"
                  checked={meta.isDefault}
                  onChange={() => void handleSetDefaultWatermark(meta.id)}
                />
                默认
              </label>

              <button type="button" onClick={() => void handleRemoveWatermark(meta)}>
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      {watermarkStatus ? (
        <div className={`status-line status-line--tight${watermarkStatus.kind === 'bad' ? ' status-bad' : ''}`}>
          {watermarkStatus.text}
        </div>
      ) : null}
    </div>
  );
}
