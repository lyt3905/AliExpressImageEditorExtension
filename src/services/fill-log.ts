import { FILL_LOG_MAX, STORAGE_KEYS } from '../shared/constants';

/**
 * 回填记录：哪些商品的主图已经换过。
 *
 * 记在**后台**而不是编辑器里：编辑器在回填成功后可能自己关掉（见 `auto-close.ts`），
 * 而这一条记录必须在标签页消失之后还活着。
 *
 * 一条记录对应**一个商品**，不是一个动作：同一个商品今天回填三次是 `count: 3`，
 * 而不是三行一样的文字 —— 卖家要回答的问题是"这个商品做过了吗"，不是"我今天点了多少次"。
 */
export type FillLogStatus = 'success' | 'unconfirmed';

export interface FillLogEntry {
  /** 稳定键，见 `fillLogKey()`；合并与去重都靠它。 */
  key: string;
  /** 商品编号（`productCode`），页面上没有就是空串。 */
  productCode: string;
  /** 商品标题，用来在列表里认出这是哪个商品。 */
  title: string;
  /** 商品页地址，列表里的「打开」就是它。 */
  url: string;
  /** 第一次回填成功的时间。 */
  firstAt: number;
  /** 最近一次回填的时间。 */
  lastAt: number;
  /** 回填了几次，至少 1。 */
  count: number;
  /** 最近一次的结果：`success` 是后台确认过，`unconfirmed` 是图进了面板但没等到完成信号。 */
  status: FillLogStatus;
}

/** 新的在前。 */
export type FillLog = readonly FillLogEntry[];

export const EMPTY_FILL_LOG: FillLog = [];

/**
 * 一个商品的稳定键。
 *
 * 优先商品编号：它在不同入口下都一样（详情页 / 编辑页 / 带一堆查询参数的链接），
 * 而且卖家自己认的就是这串号。没有编号时退回整条 URL —— 有 UA 参数也算不同商品，
 * 但那已经是我们能拿到的最好的身份了。
 */
export function fillLogKey(input: { productCode?: string; url: string }): string {
  const code = (input.productCode ?? '').trim();
  if (code.length > 0) return `code:${code}`;
  return `url:${input.url.trim()}`;
}

function normalizeEntry(value: unknown): FillLogEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const rawUrl = typeof record.url === 'string' ? record.url.trim() : '';
  const rawKey = typeof record.key === 'string' ? record.key.trim() : '';
  // 键和地址都缺的条目既打不开也认不出，留着只会占位置。
  if (rawUrl === '' && rawKey === '') return null;
  const productCode = typeof record.productCode === 'string' ? record.productCode.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const key = rawKey.length > 0 ? rawKey : fillLogKey({ productCode, url: rawUrl });
  const at = (input: unknown): number =>
    typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : 0;
  const lastAt = at(record.lastAt) || at(record.firstAt);
  const firstAt = at(record.firstAt) || lastAt;
  const rawCount = typeof record.count === 'number' && Number.isFinite(record.count) ? record.count : 1;
  const status: FillLogStatus = record.status === 'unconfirmed' ? 'unconfirmed' : 'success';
  return {
    key,
    productCode,
    title,
    url: rawUrl,
    firstAt,
    lastAt,
    count: Math.max(1, Math.floor(rawCount)),
    status,
  };
}

/**
 * 把存储里读到的任意值收成一张记录表。
 *
 * 与其它缓存同一套规则：认不出来的条目直接丢，按最近回填时间新的在前，最多 `FILL_LOG_MAX` 条。
 */
export function parseFillLog(value: unknown): FillLogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: FillLogEntry[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const entry = normalizeEntry(item);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  return entries.sort((a, b) => b.lastAt - a.lastAt).slice(0, FILL_LOG_MAX);
}

/**
 * 把一次回填并进记录表。
 *
 * 同一个商品（同一个 `key`）就更新那一条：`count + 1`、`lastAt` 往前走、状态跟着最后一次走；
 * `firstAt`、标题与编号保留（页面标题会变，改了反而认不出是哪个 listing）。
 * 新商品直接插到最前面，超上限时丢掉最久没动过的。
 */
export function mergeFillEntry(
  log: FillLog,
  entry: { key: string; productCode: string; title: string; url: string; at: number; status: FillLogStatus },
): FillLogEntry[] {
  const at = entry.at > 0 ? entry.at : Date.now();
  const existing = log.find((item) => item.key === entry.key);
  const merged: FillLogEntry = existing
    ? {
        ...existing,
        lastAt: Math.max(existing.lastAt, at),
        count: existing.count + 1,
        status: entry.status,
        // 之前没记下标题/编号（比如首次是从一个没有标题的入口做的），这次补上。
        title: existing.title || entry.title.trim(),
        productCode: existing.productCode || entry.productCode.trim(),
        url: existing.url || entry.url.trim(),
      }
    : {
        key: entry.key,
        productCode: entry.productCode.trim(),
        title: entry.title.trim(),
        url: entry.url.trim(),
        firstAt: at,
        lastAt: at,
        count: 1,
        status: entry.status,
      };
  const rest = log.filter((item) => item.key !== entry.key);
  return [merged, ...rest].sort((a, b) => b.lastAt - a.lastAt).slice(0, FILL_LOG_MAX);
}

async function readRaw(): Promise<unknown> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.fillLog);
    return stored?.[STORAGE_KEYS.fillLog];
  } catch {
    return undefined;
  }
}

export async function loadFillLog(): Promise<FillLogEntry[]> {
  return parseFillLog(await readRaw());
}

/**
 * 记下一次回填。
 *
 * 读写都包在 try/catch 里：记录是账本，不是功能 —— 存储坏掉时回填本身仍要报成功。
 */
export async function recordFill(entry: {
  productCode?: string;
  title?: string;
  url: string;
  status: FillLogStatus;
  at?: number;
}): Promise<FillLogEntry[]> {
  const key = fillLogKey({ productCode: entry.productCode, url: entry.url });
  const next = mergeFillEntry(parseFillLog(await readRaw()), {
    key,
    productCode: entry.productCode ?? '',
    title: entry.title ?? '',
    url: entry.url,
    at: entry.at ?? Date.now(),
    status: entry.status,
  });
  try {
    await chrome.storage.local.set({ [STORAGE_KEYS.fillLog]: next });
  } catch {
    /* 记不下来也不能影响回填结果 */
  }
  return next;
}

export async function clearFillLog(): Promise<void> {
  try {
    await chrome.storage.local.remove(STORAGE_KEYS.fillLog);
  } catch {
    /* ignore */
  }
}
