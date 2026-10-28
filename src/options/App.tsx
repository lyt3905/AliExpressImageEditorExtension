import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_SERVER_URL, DEFAULT_VISION_BASE_URL, DEFAULT_VISION_MODEL, MAX_BRAND_LOGO_BYTES, MAX_VISION_ENDPOINTS, MAX_WATERMARK_BYTES } from '../shared/constants';
import { messageOf } from '../shared/errors';
import { createRequestId, sendToBackground } from '../shared/messages';
import type { BrandMeta, WatermarkMeta } from '../shared/types';
import type { AuthUser } from '../services/server-api';
import type { ExtensionSettings, VisionEndpoint } from '../services/settings';
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
import {
  loadBrandCatalogState,
  setBrandCatalogSkipped,
  type BrandCatalogState,
} from '../services/brand-catalog/state';
import { syncBrandCatalog } from '../services/brand-catalog/sync';

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

function formatTimestamp(at: number): string {
  const date = new Date(at);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function catalogMirrorLabel(baseUrl: string | null): string {
  if (!baseUrl) return '';
  if (baseUrl.includes('jsdelivr')) return 'jsDelivr 镜像';
  if (baseUrl.includes('raw.githubusercontent.com')) return 'raw.githubusercontent.com';
  // A URL the seller typed in themselves — show its host, not "raw.github…".
  try {
    return `${new URL(baseUrl).host}（自填）`;
  } catch {
    return baseUrl;
  }
}

/**
 * The rows an empty chain falls back to: the built-in local gateway, with the
 * model pre-filled and the key left blank so it inherits the build-time default.
 */
function defaultEndpointRows(): VisionEndpoint[] {
  return [{ baseUrl: DEFAULT_VISION_BASE_URL, model: DEFAULT_VISION_MODEL, apiKey: '' }];
}

/**
 * Rows as they go into storage.
 *
 * Blank addresses are dropped (a row with no address can never be tried, and
 * keeping it would make the list claim a gateway that never fires). A blank
 * `model` / `apiKey` is kept blank on purpose: blank means "inherit from the first
 * row", and that resolution happens at call time, not here.
 */
function rowsForSave(rows: readonly VisionEndpoint[]): VisionEndpoint[] {
  return rows
    .map((row) => ({
      baseUrl: row.baseUrl.trim(),
      model: row.model.trim(),
      apiKey: row.apiKey.trim(),
    }))
    .filter((row) => row.baseUrl.length > 0);
}

/**
 * What the dropdown shows for one gateway: its place in the chain plus its host.
 *
 * The host is what actually tells two rows apart — three rows all reading
 * 「备用接口」are indistinguishable until you open each one. Empty rows say so
 * instead of showing nothing.
 */
function endpointLabel(endpoint: VisionEndpoint, index: number): string {
  const name = index === 0 ? '主接口' : `备用接口 ${index + 1}`;
  const raw = endpoint.baseUrl.trim();
  if (raw.length === 0) return `${name} — 未填地址`;
  try {
    return `${name} — ${new URL(raw).host}`;
  } catch {
    return `${name} — ${raw}`;
  }
}

/**
 * A brand-new row: address blank, model/key blank so they inherit the main row.
 */
function blankEndpoint(): VisionEndpoint {
  return { baseUrl: '', model: '', apiKey: '' };
}

export function OptionsApp(): JSX.Element {
  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  // Vision gateway config: drives the "AI 识别素材角色" button in the editor.
  /**
   * The vision chain, as editable rows. Always at least one row so the section
   * never renders empty; an emptied address field is dropped on save (a row with no
   * address cannot be tried).
   */
  const [visionEndpoints, setVisionEndpoints] = useState<VisionEndpoint[]>(defaultEndpointRows);
  /**
   * Which gateway is expanded for editing, or `null` when the section is
   * collapsed.
   *
   * Collapsed is the default: the chain is a piece of config you touch twice a
   * year, and three always-visible inputs per gateway made the page read as a
   * form you were supposed to fill in. The dropdown still lists the whole chain
   * (order + host) in one line, so you can see the attempt order without opening
   * anything.
   */
  const [visionTab, setVisionTab] = useState<number | null>(null);
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
  const [brandDraftKeywords, setBrandDraftKeywords] = useState<Record<string, string>>({});
  const [brandThumbs, setBrandThumbs] = useState<Record<string, string>>({});
  const [brandStatus, setBrandStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [brandBusy, setBrandBusy] = useState(false);
  /** Draft for the "add brand" form. */
  const [newBrandName, setNewBrandName] = useState('');
  const [newBrandKeywords, setNewBrandKeywords] = useState('');
  const [newBrandFile, setNewBrandFile] = useState<File | null>(null);
  const brandFileInputRef = useRef<HTMLInputElement>(null);

  // ---- catalog sync state (the catalog itself lives in the repo, not here)
  const [catalogState, setCatalogState] = useState<BrandCatalogState | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  /** Draft for the self-hosted catalog URL; `''` = use the built-in mirrors only. */
  const [catalogUrl, setCatalogUrl] = useState('');
  /** Result of the "保存视觉设置" button — kept apart from the login status line. */
  const [visionStatus, setVisionStatus] = useState<{ kind: StatusKind; text: string } | null>(null);

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
        setCatalogUrl(response.data.brandCatalogUrl ?? '');
        setVisionEndpoints(response.data.vision.length > 0 ? response.data.vision : defaultEndpointRows());
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
    setBrandDraftKeywords(Object.fromEntries(list.map((entry) => [entry.id, entry.keywords.join(', ')])));
    return list;
  }, []);

  useEffect(() => {
    void refreshBrands();
  }, [refreshBrands]);

  // ---- catalog sync

  const refreshCatalogState = useCallback(async (): Promise<BrandCatalogState> => {
    const next = await loadBrandCatalogState();
    setCatalogState(next);
    return next;
  }, []);

  useEffect(() => {
    void refreshCatalogState();
  }, [refreshCatalogState]);

  const handleSyncCatalog = useCallback(async () => {
    setCatalogBusy(true);
    setCatalogStatus({ kind: 'idle', text: '正在从 GitHub 读取品牌目录…' });
    try {
      const mirror = catalogUrl.trim();
      const outcome = await syncBrandCatalog({
        ignoreTtl: true,
        ...(mirror ? { extraBaseUrls: [mirror] } : {}),
      });
      if (!outcome.ok) {
        setCatalogStatus({ kind: 'bad', text: `同步失败：${outcome.error}` });
        await refreshCatalogState();
        return;
      }
      const { result } = outcome;
      // A refreshed logo keeps its brand id, so the cached object URL in
      // `thumbUrlsRef` would keep showing the old picture. Drop just those.
      for (const slug of result.added) {
        const id = `remote-${slug}`;
        const url = thumbUrlsRef.current[id];
        if (url) {
          URL.revokeObjectURL(url);
          delete thumbUrlsRef.current[id];
        }
      }
      if (result.added.length > 0) {
        setBrandThumbs((previous) => {
          const next = { ...previous };
          for (const slug of result.added) delete next[`remote-${slug}`];
          return next;
        });
      }
      await refreshBrands();
      await refreshCatalogState();

      const parts = [
        `新增/更新 ${result.added.length}`,
        `未变 ${result.plan.unchanged.length}`,
        `移除 ${result.removed.length}`,
      ];
      if (result.plan.conflicts.length > 0) parts.push(`本地优先 ${result.plan.conflicts.length}`);
      if (result.plan.skipped.length > 0) parts.push(`已排除 ${result.plan.skipped.length}`);
      const failure = result.failures
        .map((entry) => `${entry.slug}（${entry.message}）`)
        .join('、');
      setCatalogStatus({
        kind: result.failures.length > 0 ? 'bad' : 'ok',
        text: `同步完成：${parts.join('，')}${failure ? `；失败：${failure}` : ''}`,
      });
    } catch (error) {
      setCatalogStatus({ kind: 'bad', text: `同步失败：${messageOf(error)}` });
    } finally {
      setCatalogBusy(false);
    }
  }, [refreshBrands, refreshCatalogState, catalogUrl]);

  const handleCatalogToggle = useCallback(async (slug: string, enabled: boolean) => {
    const next = await setBrandCatalogSkipped(slug, !enabled);
    setCatalogState(next);
    setCatalogStatus({
      kind: 'idle',
      text: enabled
        ? `「${slug}」会跟随目录更新`
        : `「${slug}」已排除：同步既不覆盖也不删除它当前的 Logo`,
    });
  }, []);

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
          brandCatalogUrl: catalogUrl.trim(),
          vision: rowsForSave(visionEndpoints),
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
  }, [password, serverUrl, username, visionEndpoints, catalogUrl]);

  /**
   * Save just the vision gateway chain.
   *
   * Its own button because the shared「仅保存设置」sits under the *account*
   * fields and reads like an account action — the seller configuring gateways had
   * no obvious way to commit the rows in front of them. Everything else (server
   * URL, account) is sent unchanged so the same handler can serve both buttons.
   */
  const handleSaveVision = useCallback(async () => {
    setBusy(true);
    setVisionStatus({ kind: 'idle', text: '正在保存…' });
    try {
      const response = await sendToBackground<ExtensionSettings>({
        type: 'SAVE_SETTINGS',
        requestId: createRequestId('save-vision'),
        payload: {
          serverUrl,
          username,
          vision: rowsForSave(visionEndpoints),
        },
      });
      if (response?.ok) {
        // Read back what the store kept: blank rows were dropped and an empty list
        // falls back to the built-in gateway, so the rows should show what is
        // actually configured rather than what was typed.
        const saved = response.data?.vision ?? [];
        setVisionEndpoints(saved.length > 0 ? saved : defaultEndpointRows());
        // Saved and done — fold the section back up so the page returns to the
        // compact summary instead of leaving one gateway's inputs hanging open.
        setVisionTab(null);
        setVisionStatus({
          kind: 'ok',
          text:
            saved.length > 1
              ? `视觉设置已保存（${saved.length} 个接口，按顺序尝试）`
              : '视觉设置已保存',
        });
      } else {
        setVisionStatus({ kind: 'bad', text: `保存失败：${response?.error?.message ?? '未知错误'}` });
      }
    } catch (error) {
      setVisionStatus({ kind: 'bad', text: `保存失败：${messageOf(error)}` });
    } finally {
      setBusy(false);
    }
  }, [serverUrl, username, visionEndpoints]);

  const updateEndpoint = useCallback((index: number, patch: Partial<VisionEndpoint>) => {
    setVisionEndpoints((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }, []);

  const addEndpoint = useCallback(() => {
    if (visionEndpoints.length >= MAX_VISION_ENDPOINTS) return;
    // Expand the row we just appended: a new row added below while the section
    // stays collapsed looks like the button did nothing.
    setVisionTab(visionEndpoints.length);
    setVisionEndpoints((rows) =>
      rows.length >= MAX_VISION_ENDPOINTS ? rows : [...rows, blankEndpoint()],
    );
  }, [visionEndpoints.length]);

  const removeEndpoint = useCallback((index: number) => {
    // The last row stays: an empty chain is not a valid configuration, and a
    // section with no rows would leave nothing to type into.
    setVisionEndpoints((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));
    // Collapse: the row the editor was pointing at is gone, and silently sliding
    // to the neighbour would show someone else's address under the same cursor.
    setVisionTab(null);
  }, []);

  // The expanded row, or null when collapsed (or when the index outlived its row).
  const editingIndex =
    visionTab !== null && visionTab >= 0 && visionTab < visionEndpoints.length ? visionTab : null;
  const editingEndpoint = editingIndex === null ? null : visionEndpoints[editingIndex];

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
        keywords: parseBrandTerms(newBrandKeywords),
      });
      await refreshBrands();
      setBrandStatus({ kind: 'ok', text: `已添加品牌「${meta.name}」` });
      setNewBrandName('');
      setNewBrandKeywords('');
      setNewBrandFile(null);
      if (brandFileInputRef.current) brandFileInputRef.current.value = '';
    } catch (error) {
      setBrandStatus({ kind: 'bad', text: messageOf(error) });
    } finally {
      setBrandBusy(false);
    }
  }, [newBrandFile, newBrandKeywords, newBrandName, refreshBrands]);

  const handleSaveBrandRow = useCallback(
    async (id: string) => {
      const meta = brands.find((entry) => entry.id === id);
      if (!meta) return;
      setBrands(
        await updateBrand(id, {
          name: brandDraftNames[id],
          keywords: parseBrandTerms(brandDraftKeywords[id] ?? ''),
        }),
      );
      setBrandStatus({ kind: 'ok', text: '已保存品牌修改' });
    },
    [brandDraftKeywords, brandDraftNames, brands],
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

      <h2>AI 视觉接口</h2>
      <p className="hint">
        可选。编辑器里点「AI 识别素材角色」时，素材会以 512px 缩略图发给下面的网关判断主图 / 包装盒。
        可以配多个网关：<strong>按顺序尝试，谁先答上就用谁</strong>；上一个连不上、超时、鉴权失败或返回不是
        JSON 都算失败，自动换下一个。全部失败才回退到标签匹配，不影响其他功能。
      </p>

      <div className="field vision-picker">
        <label htmlFor="vision-picker">接口</label>
        <select
          id="vision-picker"
          value={editingIndex === null ? '' : String(editingIndex)}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            // The placeholder option is how you fold the row back up again.
            setVisionTab(next === '' ? null : Number(next));
          }}
        >
          <option value="">选择要编辑的接口…（点开才显示地址 / 模型 / Key）</option>
          {visionEndpoints.map((endpoint, index) => (
            <option key={index} value={index}>
              {endpointLabel(endpoint, index)}
            </option>
          ))}
        </select>
        <small>
          一共 {visionEndpoints.length} 个，按这个顺序尝试：
          {visionEndpoints.map((endpoint, index) => endpointLabel(endpoint, index)).join(' → ')}。
          选中哪一个，下面才展开它的设置。
        </small>
      </div>

      {editingIndex === null || editingEndpoint === null ? null : (
        <div className="vision-row">
          <div className="vision-row__head">
            <strong>{endpointLabel(editingEndpoint, editingIndex)}</strong>
            {editingIndex === 0 ? (
              <small className="vision-row__note">备用接口里留空的「模型 / Key」都继承这里</small>
            ) : (
              <small className="vision-row__note">「模型 / Key」留空 = 继承主接口</small>
            )}
            <button
              type="button"
              className="vision-row__collapse"
              disabled={busy}
              onClick={() => setVisionTab(null)}
              title="收起，不改动任何设置"
            >
              收起
            </button>
            {visionEndpoints.length > 1 ? (
              <button
                type="button"
                className="vision-row__remove"
                disabled={busy}
                onClick={() => removeEndpoint(editingIndex)}
                title="从链里移除这个接口"
              >
                移除这个接口
              </button>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="vision-base-url">接口地址</label>
            <input
              id="vision-base-url"
              value={editingEndpoint.baseUrl}
              spellCheck={false}
              onChange={(event) => updateEndpoint(editingIndex, { baseUrl: event.target.value })}
              placeholder={
                editingIndex === 0
                  ? DEFAULT_VISION_BASE_URL
                  : 'http://127.0.0.1:8788/v1（另一台机器 / 备用网关）'
              }
            />
            {editingEndpoint.baseUrl.trim().length === 0 ? (
              <small>这个接口还没填地址，保存时会被丢掉。</small>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="vision-model">视觉模型</label>
            <input
              id="vision-model"
              value={editingEndpoint.model}
              spellCheck={false}
              onChange={(event) => updateEndpoint(editingIndex, { model: event.target.value })}
              placeholder={
                editingIndex === 0
                  ? DEFAULT_VISION_MODEL
                  : `留空 = 继承主接口（${visionEndpoints[0]?.model.trim() || DEFAULT_VISION_MODEL}）`
              }
            />
          </div>

          <div className="field">
            <label htmlFor="vision-api-key">接口 Key</label>
            <input
              id="vision-api-key"
              type="password"
              value={editingEndpoint.apiKey}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => updateEndpoint(editingIndex, { apiKey: event.target.value })}
              placeholder={
                editingIndex === 0
                  ? '留空 = 使用构建期内置的默认 Key'
                  : '留空 = 继承主接口的 Key'
              }
            />
          </div>
        </div>
      )}

      <p className="hint">
        只填地址也能用：主接口留空「模型 / Key」就用构建期内置的默认值（本地开发时来自 gitignored 的{' '}
        <code>.env.local</code> 里的 <code>VITE_VISION_API_KEY</code>）。需要多图输入与 JSON 输出的模型。
      </p>

      <div className="row">
        <button
          type="button"
          disabled={busy || visionEndpoints.length >= MAX_VISION_ENDPOINTS}
          onClick={addEndpoint}
        >
          + 添加接口
        </button>
        <button type="button" className="primary" disabled={busy} onClick={() => void handleSaveVision()}>
          保存视觉设置
        </button>
      </div>

      {visionStatus ? (
        <div
          className={`status-line status-line--tight${visionStatus.kind === 'bad' ? ' status-bad' : ''}`}
        >
          {visionStatus.text}
        </div>
      ) : null}

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
        维护「品牌 → Logo」列表。只有**关键词**参与匹配：打开编辑器时拿关键词去商品标题里找（不区分大小写），
        命中的品牌 Logo 会自动作为图层加到画布上；也可以在编辑器工具栏手动选择。
        名称只用来区分不同品牌，不参与匹配——把品牌名、英文名、系列缩写都写进关键词即可。
      </p>

      <div className="catalog-block">
        <div className="catalog-block__head">
          <strong>品牌目录（GitHub）</strong>
          <span className="watermark-row__size">
            {catalogState === null
              ? '读取中…'
              : catalogState.syncedAt > 0
                ? `已同步 v${catalogState.version} · ${formatTimestamp(catalogState.syncedAt)}${catalogState.baseUrlUsed ? ` · ${catalogMirrorLabel(catalogState.baseUrlUsed)}` : ''}`
                : '从未同步'}
          </span>
        </div>
        <p className="hint">
          目录来自仓库的 <code>catalog/brands.json</code>：仓库里加一个品牌、换一张 Logo，
          这里点一次同步就能拿到，不用重新打包插件。打开编辑器时也会自动同步（24 小时内不重复请求）。
          目录里的品牌 id 固定（<code>remote-&lt;slug&gt;</code>），所以更新 Logo 不会让历史画布断图。
        </p>
        <div className="row">
          <button
            type="button"
            className="primary"
            disabled={catalogBusy}
            onClick={() => void handleSyncCatalog()}
          >
            {catalogBusy ? '正在同步…' : '立即同步'}
          </button>
        </div>
        {catalogStatus ? (
          <div
            className={`status-line status-line--tight${catalogStatus.kind === 'bad' ? ' status-bad' : ''}`}
          >
            {catalogStatus.text}
          </div>
        ) : null}
        {catalogState?.lastError ? (
          <div className="status-line status-line--tight status-bad">
            上次同步失败：{catalogState.lastError}
          </div>
        ) : null}
        <div className="field">
          <label htmlFor="catalog-url">自填目录地址（可选）</label>
          <input
            id="catalog-url"
            value={catalogUrl}
            spellCheck={false}
            disabled={catalogBusy}
            onChange={(event) => setCatalogUrl(event.target.value)}
            placeholder="https://你的域名/catalog/"
          />
          <small>
            国内访问 GitHub 不稳时，把这个仓库的 <code>catalog/</code> 镜像到别处再填这里。
            同步会先试它、失败再回落到内置镜像。留空 = 只用内置镜像。改完点上面的「设置」区保存，
            或直接「立即同步」按当前输入试一次。只接受 HTTPS（本机 <code>127.0.0.1</code> 可用 HTTP）。
          </small>
        </div>
      </div>

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
        <small>只用来区分不同品牌（这里和编辑器里的品牌下拉显示的就是它），不参与标题匹配。</small>
      </div>
      <div className="field">
        <label htmlFor="brand-keywords">标题关键词（逗号分隔）</label>
        <input
          id="brand-keywords"
          value={newBrandKeywords}
          spellCheck={false}
          disabled={brandBusy}
          onChange={(event) => setNewBrandKeywords(event.target.value)}
          placeholder="例：Morph Toys, MTS, 摩变"
        />
        <small>
          标题里出现任一关键词（<b>不区分大小写</b>）就判定为该品牌，所以把品牌名、英文名、系列缩写都写进来。
          留空 = 永不自动识别，只能在编辑器里手动选品牌。
        </small>
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
                  value={brandDraftKeywords[meta.id] ?? ''}
                  spellCheck={false}
                  placeholder="标题关键词（逗号分隔，留空 = 不自动识别）"
                  onChange={(event) =>
                    setBrandDraftKeywords((previous) => ({ ...previous, [meta.id]: event.target.value }))
                  }
                />
              </span>

              <span className="watermark-row__size">
                {meta.width}×{meta.height}
                {meta.source === 'remote' && meta.slug ? (
                  <label
                    className="watermark-row__default"
                    title="取消勾选后，目录同步既不覆盖也不删除这个品牌当前的 Logo"
                  >
                    <input
                      type="checkbox"
                      checked={!catalogState?.skipped.includes(meta.slug)}
                      disabled={catalogBusy}
                      onChange={(event) =>
                        void handleCatalogToggle(meta.slug as string, event.target.checked)
                      }
                    />
                    同步
                  </label>
                ) : null}
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
