import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SERVER_URL, DEFAULT_VISION_BASE_URL, DEFAULT_VISION_MODEL, MAX_BRAND_LOGO_BYTES, MAX_WATERMARK_BYTES } from '../shared/constants';
import { messageOf } from '../shared/errors';
import { createRequestId, sendToBackground } from '../shared/messages';
import type { BrandMeta, WatermarkMeta } from '../shared/types';
import type { AuthUser } from '../services/server-api';
import type { ExtensionSettings } from '../services/settings';
import {
  listBrands,
  loadBrandLogo,
  parseBrandTerms,
  removeBrand,
  saveBrand,
  updateBrand,
} from '../services/brand-store';
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
const LOGO_SIZE_LIMIT_MB = Math.round(MAX_BRAND_LOGO_BYTES / 1024 / 1024);

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
  // Vision gateway config: drives the "AI 识别素材角色" button in the editor.
  const [visionBaseUrl, setVisionBaseUrl] = useState(DEFAULT_VISION_BASE_URL);
  const [visionModel, setVisionModel] = useState(DEFAULT_VISION_MODEL);
  const [visionApiKey, setVisionApiKey] = useState('');
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

  // ---- brand registry state
  const [brands, setBrands] = useState<BrandMeta[]>([]);
  const [brandDraftNames, setBrandDraftNames] = useState<Record<string, string>>({});
  const [brandDraftAliases, setBrandDraftAliases] = useState<Record<string, string>>({});
  const [brandDraftKeywords, setBrandDraftKeywords] = useState<Record<string, string>>({});
  const [brandThumbs, setBrandThumbs] = useState<Record<string, string>>({});
  const [brandStatus, setBrandStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [brandBusy, setBrandBusy] = useState(false);
  /** Draft for the "add brand" form. */
  const [newBrandName, setNewBrandName] = useState('');
  const [newBrandAliases, setNewBrandAliases] = useState('');
  const [newBrandKeywords, setNewBrandKeywords] = useState('');
  const [newBrandFile, setNewBrandFile] = useState<File | null>(null);
  const brandFileInputRef = useRef<HTMLInputElement>(null);

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
        if (response.data.vision) {
          setVisionBaseUrl(response.data.vision.baseUrl);
          setVisionModel(response.data.vision.model);
          setVisionApiKey(response.data.vision.apiKey);
        }
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

  // ---- brand registry

  const refreshBrands = useCallback(async (): Promise<BrandMeta[]> => {
    const list = await listBrands();
    setBrands(list);
    setBrandDraftNames(Object.fromEntries(list.map((entry) => [entry.id, entry.name])));
    setBrandDraftAliases(Object.fromEntries(list.map((entry) => [entry.id, entry.aliases.join(', ')])));
    setBrandDraftKeywords(Object.fromEntries(list.map((entry) => [entry.id, entry.keywords.join(', ')])));
    return list;
  }, []);

  useEffect(() => {
    void refreshBrands();
  }, [refreshBrands]);

  // ---- thumbnail object URLs for the brand list
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      for (const meta of brands) {
        if (thumbUrlsRef.current[meta.id]) continue;
        const blob = await loadBrandLogo(meta);
        if (!blob || cancelled) continue;
        const url = URL.createObjectURL(blob);
        thumbUrlsRef.current[meta.id] = url;
        if (!cancelled) setBrandThumbs((previous) => ({ ...previous, [meta.id]: url }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [brands]);

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
        payload: {
          serverUrl,
          username,
          ...(password ? { password } : {}),
          vision: { baseUrl: visionBaseUrl, model: visionModel, apiKey: visionApiKey },
        },
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
  }, [password, serverUrl, username, visionApiKey, visionBaseUrl, visionModel]);

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

  // ---- brand management

  const handleAddBrand = useCallback(async () => {
    if (!newBrandFile) {
      setBrandStatus({ kind: 'bad', text: '请先选择 Logo 图片' });
      return;
    }
    setBrandBusy(true);
    setBrandStatus({ kind: 'idle', text: `正在添加品牌「${newBrandName || newBrandFile.name}」…` });
    try {
      const meta = await saveBrand({
        file: newBrandFile,
        name: newBrandName || newBrandFile.name.replace(/\.[^.]+$/, ''),
        aliases: parseBrandTerms(newBrandAliases),
        keywords: parseBrandTerms(newBrandKeywords),
      });
      await refreshBrands();
      setBrandStatus({ kind: 'ok', text: `已添加品牌「${meta.name}」` });
      setNewBrandName('');
      setNewBrandAliases('');
      setNewBrandKeywords('');
      setNewBrandFile(null);
      if (brandFileInputRef.current) brandFileInputRef.current.value = '';
    } catch (error) {
      setBrandStatus({ kind: 'bad', text: messageOf(error) });
    } finally {
      setBrandBusy(false);
    }
  }, [newBrandAliases, newBrandFile, newBrandKeywords, newBrandName, refreshBrands]);

  const handleSaveBrandRow = useCallback(
    async (id: string) => {
      const meta = brands.find((entry) => entry.id === id);
      if (!meta) return;
      setBrands(
        await updateBrand(id, {
          name: brandDraftNames[id],
          aliases: parseBrandTerms(brandDraftAliases[id] ?? ''),
          keywords: parseBrandTerms(brandDraftKeywords[id] ?? ''),
        }),
      );
      setBrandStatus({ kind: 'ok', text: '已保存品牌修改' });
    },
    [brandDraftAliases, brandDraftKeywords, brandDraftNames, brands],
  );

  const handleRemoveBrand = useCallback(async (meta: BrandMeta) => {
    if (!window.confirm(`确定删除品牌「${meta.name}」吗？该操作不可撤销。`)) return;
    const cached = thumbUrlsRef.current[meta.id];
    if (cached) {
      URL.revokeObjectURL(cached);
      delete thumbUrlsRef.current[meta.id];
    }
    setBrandThumbs((previous) => {
      const next = { ...previous };
      delete next[meta.id];
      return next;
    });
    setBrands(await removeBrand(meta.id));
    setBrandStatus({ kind: 'ok', text: `已删除「${meta.name}」` });
  }, []);

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

      <div className="field">
        <label htmlFor="vision-base-url">视觉接口地址</label>
        <input
          id="vision-base-url"
          value={visionBaseUrl}
          spellCheck={false}
          onChange={(event) => setVisionBaseUrl(event.target.value)}
          placeholder={DEFAULT_VISION_BASE_URL}
        />
        <small>
          兼容 OpenAI 协议的本地网关（默认 {DEFAULT_VISION_BASE_URL}）。素材会以 512px 缩略图发给它，
          用于「AI 识别素材角色」；不可用时自动回退到标签匹配。
        </small>
      </div>

      <div className="field">
        <label htmlFor="vision-model">视觉模型</label>
        <input
          id="vision-model"
          value={visionModel}
          spellCheck={false}
          onChange={(event) => setVisionModel(event.target.value)}
          placeholder={DEFAULT_VISION_MODEL}
        />
        <small>需要支持多图输入与 JSON 输出，默认 {DEFAULT_VISION_MODEL}。</small>
      </div>

      <div className="field">
        <label htmlFor="vision-api-key">视觉接口 Key</label>
        <input
          id="vision-api-key"
          type="password"
          value={visionApiKey}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setVisionApiKey(event.target.value)}
          placeholder="留空 = 使用构建期内置的默认 Key"
        />
        <small>
          本地构建时会从 gitignored 的 <code>.env.local</code> 预填（<code>VITE_VISION_API_KEY</code>），
          这里保存的值会覆盖它；留空则继续用内置默认值，两者都没有时不发送 <code>Authorization</code> 头。
        </small>
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

      <hr className="section-divider" />

      <h2>品牌商标</h2>
      <p className="hint">
        维护「品牌 → Logo」列表。打开编辑器时会用 <strong>名称 / 别名 / 关键词</strong> 匹配商品标题，
        命中的品牌 Logo 会自动作为图层加到画布上；也可以在编辑器工具栏手动选择。
        同一品牌的多个称呼都填在「别名」里即可，名称和别名本身就参与匹配。
      </p>

      <div className="field">
        <label htmlFor="brand-file">Logo 图片</label>
        <input
          id="brand-file"
          ref={brandFileInputRef}
          type="file"
          accept={ACCEPTED_TYPES}
          disabled={brandBusy}
          onChange={(event) => setNewBrandFile(event.target.files?.[0] ?? null)}
        />
        <small>PNG（可带透明通道，推荐）／JPEG／WebP，单张上限 {LOGO_SIZE_LIMIT_MB}MB。</small>
      </div>
      <div className="field">
        <label htmlFor="brand-name">品牌名称</label>
        <input
          id="brand-name"
          value={newBrandName}
          spellCheck={false}
          disabled={brandBusy}
          onChange={(event) => setNewBrandName(event.target.value)}
          placeholder="例：Morph Toys"
        />
      </div>
      <div className="field">
        <label htmlFor="brand-aliases">别名（同品牌的其他叫法，逗号分隔）</label>
        <input
          id="brand-aliases"
          value={newBrandAliases}
          spellCheck={false}
          disabled={brandBusy}
          onChange={(event) => setNewBrandAliases(event.target.value)}
          placeholder="例：MT, MorphToys, 摩变"
        />
      </div>
      <div className="field">
        <label htmlFor="brand-keywords">标题关键词（可选，逗号分隔）</label>
        <input
          id="brand-keywords"
          value={newBrandKeywords}
          spellCheck={false}
          disabled={brandBusy}
          onChange={(event) => setNewBrandKeywords(event.target.value)}
          placeholder="例：Transformation Galaxy, OP Commander"
        />
        <small>标题里出现任一「名称 / 别名 / 关键词」（不区分大小写）即判定为该品牌。</small>
      </div>
      <div className="row">
        <button type="button" className="primary" disabled={brandBusy || !newBrandFile} onClick={() => void handleAddBrand()}>
          添加品牌
        </button>
      </div>

      {brands.length === 0 ? (
        <div className="empty">还没有品牌，先上传一张 Logo 并填上名称。</div>
      ) : (
        <div className="watermark-list">
          {brands.map((meta) => (
            <div className="watermark-row watermark-row--brand" key={meta.id}>
              <span className="watermark-row__thumb">
                {brandThumbs[meta.id] ? (
                  <img src={brandThumbs[meta.id]} alt="" />
                ) : (
                  <span className="watermark-row__thumb-empty" />
                )}
              </span>

              <span className="watermark-row__brand-fields">
                <input
                  value={brandDraftNames[meta.id] ?? meta.name}
                  spellCheck={false}
                  placeholder="品牌名称"
                  onChange={(event) =>
                    setBrandDraftNames((previous) => ({ ...previous, [meta.id]: event.target.value }))
                  }
                />
                <input
                  value={brandDraftAliases[meta.id] ?? ''}
                  spellCheck={false}
                  placeholder="别名（逗号分隔）"
                  onChange={(event) =>
                    setBrandDraftAliases((previous) => ({ ...previous, [meta.id]: event.target.value }))
                  }
                />
                <input
                  value={brandDraftKeywords[meta.id] ?? ''}
                  spellCheck={false}
                  placeholder="标题关键词（逗号分隔）"
                  onChange={(event) =>
                    setBrandDraftKeywords((previous) => ({ ...previous, [meta.id]: event.target.value }))
                  }
                />
              </span>

              <span className="watermark-row__size">
                {meta.width}×{meta.height}
              </span>

              <button type="button" onClick={() => void handleSaveBrandRow(meta.id)}>
                保存
              </button>
              <button type="button" onClick={() => void handleRemoveBrand(meta)}>
                删除
              </button>
            </div>
          ))}
        </div>
      )}

      {brandStatus ? (
        <div className={`status-line status-line--tight${brandStatus.kind === 'bad' ? ' status-bad' : ''}`}>
          {brandStatus.text}
        </div>
      ) : null}
    </div>
  );
}
