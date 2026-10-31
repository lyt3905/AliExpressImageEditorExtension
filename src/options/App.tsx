import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SERVER_URL,
  MAX_BRAND_LOGO_BYTES,
  MAX_VISION_ENDPOINTS,
  MAX_WATERMARK_BYTES,
} from '../shared/constants';
import { messageOf } from '../shared/errors';
import { createRequestId, sendToBackground } from '../shared/messages';
import type { BrandMeta, WatermarkMeta } from '../shared/types';
import type { AuthUser } from '../services/server-api';
import type { ExtensionSettings, VisionEndpoint } from '../services/settings';
import { askVisionJson } from '../services/vision-client';
import { resolveVisionConfigs } from '../services/vision-endpoints';
import { clearErrorLog, loadErrorLog, type ErrorLogEntry } from '../services/error-log';
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
import { buildCatalogBundle } from '../services/brand-catalog/export-bundle';
import { downloadBlobInPage } from '../services/downloader';
import { SaveBar } from './components/SaveBar';
import type { SaveBarStatus } from './components/SaveBar';
import { StatusBadge } from './components/StatusBadge';
import { Tabs } from './components/Tabs';
import type { TabItem } from './components/Tabs';
import { AccountSection } from './sections/AccountSection';
import { VisionSection } from './sections/VisionSection';
import type { VisionTestResult } from './sections/VisionSection';
import { WatermarkSection } from './sections/WatermarkSection';
import { BrandSection } from './sections/BrandSection';
import {
  blankEndpoint,
  defaultEndpointRows,
  endpointLabel,
  originPatternOf,
  rowsForSave,
} from './helpers';

const ACCEPTED_TYPES = 'image/png,image/jpeg,image/webp';
const SIZE_LIMIT_MB = Math.round(MAX_WATERMARK_BYTES / 1024 / 1024);
const LOGO_SIZE_LIMIT_MB = Math.round(MAX_BRAND_LOGO_BYTES / 1024 / 1024);

type StatusKind = 'ok' | 'bad' | 'idle';
type TabId = 'account' | 'vision' | 'watermark' | 'brand';

/**
 * 一份"可保存设置"的指纹，用来判断底部「保存更改」该不该亮。
 *
 * 只算真正会被 SAVE_SETTINGS 写进去的东西；密码不算（它只活在会话里，而且保存后被清空），
 * 账号/密码表单的展开状态、列表翻页、搜索词这些界面状态当然也不算——它们不该让按钮变蓝。
 */
function snapshotOf(input: {
  serverUrl: string;
  username: string;
  catalogUrl: string;
  vision: readonly VisionEndpoint[];
  editingIndex?: number | null;
}): string {
  return JSON.stringify({
    serverUrl: input.serverUrl.trim(),
    username: input.username.trim(),
    catalogUrl: input.catalogUrl.trim(),
    vision: rowsForSave(input.vision),
  });
}

/**
 * 设置页外壳。
 *
 * 结构：页头（只放"我是谁、连上没有"）+ 四个分类（同时挂载，非活动的 `hidden`）+
 * 底部统一保存栏。**一次只显示一个分类**，但四个面板都留在 DOM 里——切换标签不卸载，
 * 未保存的草稿自然就保住了，不需要额外的"暂存"逻辑。
 *
 * 所有数据与副作用都在这里；`sections/` 下的四个组件只负责渲染，不自己读存储。
 */
export function OptionsApp(): JSX.Element {
  const [activeTab, setActiveTab] = useState<TabId>('account');

  const [serverUrl, setServerUrl] = useState(DEFAULT_SERVER_URL);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [visionEndpoints, setVisionEndpoints] = useState<VisionEndpoint[]>(defaultEndpointRows);
  const [status, setStatus] = useState<string>('');
  const [statusKind, setStatusKind] = useState<StatusKind>('idle');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [errorLog, setErrorLog] = useState<ErrorLogEntry[]>([]);
  const [busy, setBusy] = useState(false);

  /** 已保存设置的指纹；和当前值不等就说明有未保存改动。 */
  const [savedSnapshot, setSavedSnapshot] = useState<string>('');
  const [saveStatus, setSaveStatus] = useState<SaveBarStatus | null>(null);
  /** 登录表单是否展开：登录成功后收起，点「重新登录」再放出来。 */
  const [loginFormOpen, setLoginFormOpen] = useState(false);

  // ---- vision editing
  const [editingEndpoint, setEditingEndpoint] = useState<number | null>(null);
  const [testingIndex, setTestingIndex] = useState<number | null>(null);
  const [visionTestResults, setVisionTestResults] = useState<Record<number, VisionTestResult>>({});
  const [visionStatus, setVisionStatus] = useState<{ kind: StatusKind; text: string } | null>(null);

  // ---- watermark
  const [watermarks, setWatermarks] = useState<WatermarkMeta[]>([]);
  const [watermarkNames, setWatermarkNames] = useState<Record<string, string>>({});
  const [watermarkThumbs, setWatermarkThumbs] = useState<Record<string, string>>({});
  const [watermarkStatus, setWatermarkStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [watermarkBusy, setWatermarkBusy] = useState(false);
  const watermarkFileRef = useRef<HTMLInputElement>(null);

  // ---- brand
  const [brands, setBrands] = useState<BrandMeta[]>([]);
  const [brandDraftNames, setBrandDraftNames] = useState<Record<string, string>>({});
  const [brandDraftKeywords, setBrandDraftKeywords] = useState<Record<string, string>>({});
  const [brandThumbs, setBrandThumbs] = useState<Record<string, string>>({});
  const [brandStatus, setBrandStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [brandBusy, setBrandBusy] = useState(false);
  const [editingBrandId, setEditingBrandId] = useState<string | null>(null);
  const [brandFormOpen, setBrandFormOpen] = useState(false);
  const [newBrandName, setNewBrandName] = useState('');
  const [newBrandKeywords, setNewBrandKeywords] = useState('');
  const [newBrandFile, setNewBrandFile] = useState<File | null>(null);
  const brandFileInputRef = useRef<HTMLInputElement>(null);

  // ---- catalog sync
  const [catalogState, setCatalogState] = useState<BrandCatalogState | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [catalogStatus, setCatalogStatus] = useState<{ kind: StatusKind; text: string } | null>(null);
  const [catalogUrl, setCatalogUrl] = useState('');

  const thumbUrlsRef = useRef<Record<string, string>>({});

  const refreshAuthState = useCallback(async (): Promise<boolean> => {
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

  const refreshBrands = useCallback(async (): Promise<BrandMeta[]> => {
    const list = await listBrands();
    setBrands(list);
    setBrandDraftNames(Object.fromEntries(list.map((entry) => [entry.id, entry.name])));
    setBrandDraftKeywords(Object.fromEntries(list.map((entry) => [entry.id, entry.keywords.join(', ')])));
    return list;
  }, []);

  const refreshCatalogState = useCallback(async (): Promise<BrandCatalogState> => {
    const next = await loadBrandCatalogState();
    setCatalogState(next);
    return next;
  }, []);

  /** 重新读一遍设置。保存成功和「放弃修改」都走这里，保证界面显示的就是存储里的值。 */
  const loadSettings = useCallback(async (): Promise<void> => {
    const response = await sendToBackground<ExtensionSettings>({
      type: 'GET_SETTINGS',
      requestId: createRequestId('settings'),
    });
    if (response?.ok && response.data) {
      const data = response.data;
      const rows = data.vision.length > 0 ? data.vision : defaultEndpointRows();
      setServerUrl(data.serverUrl);
      setUsername(data.username);
      setCatalogUrl(data.brandCatalogUrl ?? '');
      setVisionEndpoints(rows);
      setSavedSnapshot(
        snapshotOf({
          serverUrl: data.serverUrl,
          username: data.username,
          catalogUrl: data.brandCatalogUrl ?? '',
          vision: rows,
        }),
      );
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await loadSettings();
      const loggedIn = await refreshAuthState();
      setStatus(loggedIn ? '已登录' : '未登录');
      setStatusKind(loggedIn ? 'ok' : 'idle');
      // 已登录的人不需要再看账号/密码框。
      if (loggedIn) setLoginFormOpen(false);
      setErrorLog(await loadErrorLog());
    })();
  }, [loadSettings, refreshAuthState]);

  useEffect(() => {
    void refreshWatermarks();
  }, [refreshWatermarks]);

  useEffect(() => {
    void refreshBrands();
  }, [refreshBrands]);

  useEffect(() => {
    void refreshCatalogState();
  }, [refreshCatalogState]);

  // ---- 未保存改动的指纹
  const currentSnapshot = snapshotOf({ serverUrl, username, catalogUrl, vision: visionEndpoints });
  const dirty = savedSnapshot !== '' && currentSnapshot !== savedSnapshot;

  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      // Chrome 只认这个字段，文案由浏览器决定。
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // ---- 账号
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
      setStatus('已登录');
      setStatusKind('ok');
      setPassword('');
      setSaveStatus(null);
      // 登录同时把服务地址与账号写了进去，所以指纹要跟着走，否则底部会一直亮"有未保存的修改"。
      setSavedSnapshot(
        snapshotOf({ serverUrl, username, catalogUrl, vision: visionEndpoints }),
      );
      // 登录成功后收起表单：这里已经只剩"我在用什么身份"值得看。
      setLoginFormOpen(false);
    } catch (error) {
      setStatus(`登录失败：${messageOf(error)}`);
      setStatusKind('bad');
    } finally {
      setBusy(false);
    }
  }, [catalogUrl, password, serverUrl, username, visionEndpoints]);

  const handleLogout = useCallback(async () => {
    setBusy(true);
    try {
      await sendToBackground({ type: 'LOGOUT', requestId: createRequestId('logout') });
      setUser(null);
      setPassword('');
      setStatus('已退出登录');
      setStatusKind('idle');
      setLoginFormOpen(true);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleRefreshAuth = useCallback(async () => {
    setBusy(true);
    try {
      const loggedIn = await refreshAuthState();
      setStatus(loggedIn ? '已登录' : '未登录');
      setStatusKind(loggedIn ? 'ok' : 'idle');
    } finally {
      setBusy(false);
    }
  }, [refreshAuthState]);

  /** 清空错误记录：只清历史，不动登录态与设置。 */
  const handleClearErrorLog = useCallback(async () => {
    await clearErrorLog();
    setErrorLog([]);
  }, []);

  // ---- 保存
  /**
   * 唯一的提交路径。
   *
   * `origin` 只影响提示文案（视觉抽屉里点保存 vs 底部保存栏），走的仍是同一个消息、
   * 同一份 payload——两个入口不能各自拼一套参数，否则总有一个会漏字段（10.8.1 就是这么
   * 丢过 vision 的）。
   */
  const saveSettings = useCallback(
    async (origin: 'bar' | 'vision') => {
      setBusy(true);
      if (origin === 'vision') setVisionStatus({ kind: 'idle', text: '正在保存…' });
      try {
        const rows = rowsForSave(visionEndpoints);
        const response = await sendToBackground<ExtensionSettings>({
          type: 'SAVE_SETTINGS',
          requestId: createRequestId('save'),
          payload: {
            serverUrl,
            username,
            ...(password ? { password } : {}),
            brandCatalogUrl: catalogUrl.trim(),
            vision: rows,
          },
        });
        if (!response?.ok) {
          const text = `保存失败：${response?.error?.message ?? '未知错误'}`;
          setSaveStatus({ kind: 'bad', text });
          if (origin === 'vision') setVisionStatus({ kind: 'bad', text });
          return;
        }
        // 读回落库后的值：空地址行被丢掉、空链回落默认，界面要显示"实际存下来的"而不是"刚才打的"。
        const saved = response.data?.vision ?? [];
        const nextVision = saved.length > 0 ? saved : defaultEndpointRows();
        setVisionEndpoints(nextVision);
        setSavedSnapshot(
          snapshotOf({
            serverUrl: response.data?.serverUrl ?? serverUrl,
            username: response.data?.username ?? username,
            catalogUrl: response.data?.brandCatalogUrl ?? catalogUrl,
            vision: nextVision,
          }),
        );
        setSaveStatus({ kind: 'ok', text: '设置已保存' });
        if (origin === 'vision') {
          setVisionStatus({
            kind: 'ok',
            text:
              nextVision.length > 1
                ? `视觉设置已保存（${nextVision.length} 个接口，按顺序尝试）`
                : '视觉设置已保存',
          });
          setEditingEndpoint(null);
        }
      } catch (error) {
        const text = `保存失败：${messageOf(error)}`;
        setSaveStatus({ kind: 'bad', text });
        if (origin === 'vision') setVisionStatus({ kind: 'bad', text });
      } finally {
        setBusy(false);
      }
    },
    [catalogUrl, password, serverUrl, username, visionEndpoints],
  );

  const handleReset = useCallback(() => {
    setSaveStatus(null);
    setVisionStatus(null);
    void loadSettings();
  }, [loadSettings]);

  // ---- 视觉接口行
  const updateEndpoint = useCallback((index: number, patch: Partial<VisionEndpoint>) => {
    setVisionEndpoints((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    // 改了地址/模型/Key 之后旧的测试结论就不作数了。
    setVisionTestResults((previous) => {
      const next = { ...previous };
      delete next[index];
      return next;
    });
  }, []);

  const addEndpoint = useCallback(() => {
    if (visionEndpoints.length >= MAX_VISION_ENDPOINTS) return;
    setVisionEndpoints((rows) =>
      rows.length >= MAX_VISION_ENDPOINTS ? rows : [...rows, blankEndpoint()],
    );
    // 直接打开新行：加了却不展开，看起来像按钮没反应。
    setEditingEndpoint(visionEndpoints.length);
  }, [visionEndpoints.length]);

  const removeEndpoint = useCallback((index: number) => {
    // 最后一行留着：空链不是合法配置，一个没有行的分区也没有地方可填。
    setVisionEndpoints((rows) => (rows.length <= 1 ? rows : rows.filter((_, i) => i !== index)));
    setEditingEndpoint(null);
    setVisionTestResults((previous) => {
      const next: Record<number, VisionTestResult> = {};
      for (const [key, value] of Object.entries(previous)) {
        const at = Number(key);
        if (at === index) continue;
        next[at > index ? at - 1 : at] = value;
      }
      return next;
    });
  }, []);

  const handleTestVision = useCallback(
    async (index: number) => {
      const configs = resolveVisionConfigs(visionEndpoints);
      const config = configs[index];
      if (!config) return;
      setTestingIndex(index);
      setVisionStatus({ kind: 'idle', text: `正在测试 ${endpointLabel(visionEndpoints[index] ?? config, index)}…` });
      try {
        // 真发一条最短的请求：不带图，但要求 JSON——能答上来就说明这个网关至少能做绑定需要的两件事。
        const answer = await askVisionJson({
          config,
          prompt: '这是一条连通性测试。请只回一个 JSON 对象：{"ok":true}',
          images: [],
          timeoutMs: 15_000,
        });
        setVisionTestResults((previous) => ({
          ...previous,
          [index]: { kind: 'ok', text: `可用 · ${Math.round(answer.elapsedMs)}ms`, at: Date.now() },
        }));
        setVisionStatus({ kind: 'ok', text: `${endpointLabel(visionEndpoints[index] ?? config, index)} 可用` });
      } catch (error) {
        setVisionTestResults((previous) => ({
          ...previous,
          [index]: { kind: 'bad', text: '不可用', at: Date.now() },
        }));
        setVisionStatus({
          kind: 'bad',
          text: `测试失败（${endpointLabel(visionEndpoints[index] ?? config, index)}）：${messageOf(error)}`,
        });
      } finally {
        setTestingIndex(null);
      }
    },
    [visionEndpoints],
  );

  // ---- 目录同步
  /**
   * 申请「自填目录地址」那个域名的主机权限。
   *
   * 必须在点击事件里**同步**调用：`chrome.permissions.request()` 要求用户手势，await
   * 一次之后手势就丢了（Chrome 会静默拒绝、连弹框都不出）。所以这里不返回 Promise，
   * 结果只用来写一行状态：拒绝不等于保存失败，但同步一定拿不到数据，得让人知道原因。
   */
  const requestCatalogOrigin = useCallback((rawUrl: string) => {
    const pattern = originPatternOf(rawUrl);
    if (!pattern) return;
    const permissions = chrome.permissions;
    if (!permissions?.request) return;
    void permissions
      .request({ origins: [pattern] })
      .then((granted) => {
        if (granted) return;
        setCatalogStatus({
          kind: 'bad',
          text: `没有拿到访问 ${pattern} 的权限。浏览器会直接拦掉这个域名的同步请求 —— 再点一次「立即同步」，在弹出的对话框里选「允许」。`,
        });
      })
      .catch(() => undefined);
  }, []);

  /**
   * 把当前品牌注册表导出成 `catalog/` 同构的 zip（`brands.json` + `logos/*`）。
   *
   * 这是手工上传的 Logo 唯一能跨机器流通的方式：它只活在这一个浏览器配置里，目录同步
   * 永远不会碰它（只有 `source: 'remote'` 的条目会被同步更新）。导出成目录包之后，
   * 把它放到任意 HTTPS 静态空间、在「自填目录地址」填那个地址，别的客户端一次同步就全拿到。
   */
  const handleExportBundle = useCallback(async () => {
    setCatalogBusy(true);
    setCatalogStatus({ kind: 'idle', text: '正在打包品牌目录…' });
    try {
      const brands = await listBrands();
      if (brands.length === 0) {
        setCatalogStatus({
          kind: 'bad',
          text: '还没有品牌可以导出：先在下面「+ 添加品牌」，或点「立即同步」从目录拉一份。',
        });
        return;
      }
      const bundle = await buildCatalogBundle(brands, {
        loadLogo: (brand) => loadBrandLogo(brand),
      });
      await downloadBlobInPage(bundle.blob, bundle.fileName);
      const skipped =
        bundle.skipped.length > 0
          ? `；${bundle.skipped.length} 个品牌读不到 Logo，已跳过（${bundle.skipped.join('、')}）`
          : '';
      setCatalogStatus({
        kind: bundle.skipped.length > 0 ? 'bad' : 'ok',
        text: `已导出 ${bundle.brands.length} 个品牌 → ${bundle.fileName}${skipped}。把 zip 里的 brands.json 与 logos/ 原样传到你的 HTTPS 空间，再在「自填目录地址」填那个目录的地址。`,
      });
    } catch (error) {
      setCatalogStatus({ kind: 'bad', text: `导出失败：${messageOf(error)}` });
    } finally {
      setCatalogBusy(false);
    }
  }, []);

  const handleSyncCatalog = useCallback(async () => {
    // 先申请权限再发请求：自填域名不在 manifest 的 host_permissions 里，没授权时
    // 请求会被浏览器拦成"CORS 失败"，看上去像对方服务器坏了。
    requestCatalogOrigin(catalogUrl);
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
      const failure = result.failures.map((entry) => `${entry.slug}（${entry.message}）`).join('、');
      setCatalogStatus({
        kind: result.failures.length > 0 ? 'bad' : 'ok',
        text: `同步完成：${parts.join('，')}${failure ? `；失败：${failure}` : ''}`,
      });
    } catch (error) {
      setCatalogStatus({ kind: 'bad', text: `同步失败：${messageOf(error)}` });
    } finally {
      setCatalogBusy(false);
    }
  }, [catalogUrl, refreshBrands, refreshCatalogState, requestCatalogOrigin]);

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

  // ---- 缩略图的 object URL（品牌 + 水印共用一个池）
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

  // ---- 水印
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
        if (watermarkFileRef.current) watermarkFileRef.current.value = '';
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

  const handleRemoveWatermark = useCallback(async (meta: WatermarkMeta) => {
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
  }, []);

  // ---- 品牌
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
      setBrandFormOpen(false);
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
      setEditingBrandId(null);
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
    setEditingBrandId((current) => (current === meta.id ? null : current));
  }, []);

  const tabs: TabItem[] = [
    { id: 'account', label: '账号连接' },
    { id: 'vision', label: 'AI 视觉', count: visionEndpoints.length },
    { id: 'watermark', label: '水印', count: watermarks.length },
    { id: 'brand', label: '品牌商标', count: brands.length },
  ];

  return (
    <div className="opt-page">
      <header className="opt-header">
        <div>
          <h1>AliExpress 图片编辑器</h1>
          <p className="opt-header__sub">
            登录、AI 视觉接口、水印与品牌 Logo。改动集中到页面底部一次保存。
          </p>
        </div>
        <div className="opt-header__status">
          <StatusBadge kind={user ? 'ok' : 'idle'} label={user ? '已连接' : '未登录'} />
          <span className="opt-header__user">
            {user ? `${user.username}${user.role ? ` · ${user.role}` : ''}` : '—'}
          </span>
        </div>
      </header>

      <div className="opt-shell">
        <Tabs items={tabs} active={activeTab} onChange={(id) => setActiveTab(id as TabId)} idPrefix="opt" />

        <main className="opt-main">
          <div
            role="tabpanel"
            id="opt-panel-account"
            aria-labelledby="opt-tab-account"
            hidden={activeTab !== 'account'}
          >
            <AccountSection
              serverUrl={serverUrl}
              onServerUrlChange={setServerUrl}
              username={username}
              onUsernameChange={setUsername}
              password={password}
              onPasswordChange={setPassword}
              user={user}
              busy={busy}
              status={status}
              statusKind={statusKind}
              formOpen={loginFormOpen}
              onFormOpenChange={setLoginFormOpen}
              onLogin={() => void handleLogin()}
              onLogout={() => void handleLogout()}
              onRefresh={() => void handleRefreshAuth()}
              errorLog={errorLog}
              onClearErrorLog={() => void handleClearErrorLog()}
              serverUrlDirty={savedSnapshot !== '' && snapshotOf({ serverUrl, username, catalogUrl, vision: visionEndpoints }) !== savedSnapshot}
            />
          </div>

          <div
            role="tabpanel"
            id="opt-panel-vision"
            aria-labelledby="opt-tab-vision"
            hidden={activeTab !== 'vision'}
          >
            <VisionSection
              endpoints={visionEndpoints}
              editingIndex={editingEndpoint}
              editing={editingEndpoint === null ? null : visionEndpoints[editingEndpoint] ?? null}
              busy={busy}
              dirty={dirty}
              testingIndex={testingIndex}
              testResults={visionTestResults}
              status={visionStatus}
              onEdit={setEditingEndpoint}
              onUpdate={updateEndpoint}
              onAdd={addEndpoint}
              onRemove={removeEndpoint}
              onTest={(index) => void handleTestVision(index)}
              onSave={() => void saveSettings('vision')}
            />
          </div>

          <div
            role="tabpanel"
            id="opt-panel-watermark"
            aria-labelledby="opt-tab-watermark"
            hidden={activeTab !== 'watermark'}
          >
            <WatermarkSection
              watermarks={watermarks}
              names={watermarkNames}
              thumbs={watermarkThumbs}
              busy={watermarkBusy}
              status={watermarkStatus}
              sizeLimitMb={SIZE_LIMIT_MB}
              accept={ACCEPTED_TYPES}
              fileInputRef={watermarkFileRef}
              onAdd={(file) => void handleAddWatermark(file)}
              onNameChange={(id, value) =>
                setWatermarkNames((previous) => ({ ...previous, [id]: value }))
              }
              onRename={(id) => void handleRenameWatermark(id)}
              onSetDefault={(id) => void handleSetDefaultWatermark(id)}
              onRemove={(meta) => void handleRemoveWatermark(meta)}
            />
          </div>

          <div
            role="tabpanel"
            id="opt-panel-brand"
            aria-labelledby="opt-tab-brand"
            hidden={activeTab !== 'brand'}
          >
            <BrandSection
              brands={brands}
              thumbs={brandThumbs}
              busy={brandBusy}
              status={brandStatus}
              catalog={{
                state: catalogState,
                busy: catalogBusy,
                status: catalogStatus,
                url: catalogUrl,
                dirty: savedSnapshot !== '' && catalogUrl.trim() !== (catalogState?.baseUrlUsed ?? catalogUrl.trim()),
                onUrlChange: setCatalogUrl,
                onSync: () => void handleSyncCatalog(),
                onExport: () => void handleExportBundle(),
                onToggleSync: (slug, enabled) => void handleCatalogToggle(slug, enabled),
              }}
              draft={{
                names: brandDraftNames,
                keywords: brandDraftKeywords,
                onName: (id, value) => setBrandDraftNames((previous) => ({ ...previous, [id]: value })),
                onKeywords: (id, value) =>
                  setBrandDraftKeywords((previous) => ({ ...previous, [id]: value })),
              }}
              add={{
                open: brandFormOpen,
                onOpenChange: setBrandFormOpen,
                name: newBrandName,
                onName: setNewBrandName,
                keywords: newBrandKeywords,
                onKeywords: setNewBrandKeywords,
                file: newBrandFile,
                onFile: setNewBrandFile,
                fileInputRef: brandFileInputRef,
                sizeLimitMb: LOGO_SIZE_LIMIT_MB,
                accept: ACCEPTED_TYPES,
                onSubmit: () => void handleAddBrand(),
              }}
              edit={{
                id: editingBrandId,
                onOpen: setEditingBrandId,
                onSave: (id) => void handleSaveBrandRow(id),
                onRemove: (meta) => void handleRemoveBrand(meta),
              }}
            />
          </div>
        </main>
      </div>

      <SaveBar
        dirty={dirty}
        busy={busy}
        status={saveStatus}
        onSave={() => {
          // 保存自填目录地址的同时顺手申请该域名的权限：这是唯一带用户手势的时刻，
          // 编辑器里的静默同步没法弹权限框（没有手势，浏览器会直接拒绝）。
          requestCatalogOrigin(catalogUrl);
          void saveSettings('bar');
        }}
        onReset={handleReset}
      />
    </div>
  );
}
