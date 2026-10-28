import { ERROR_LOG_MAX, STORAGE_KEYS } from '../shared/constants';

/**
 * 一条失败记录。
 *
 * `count` 是同一个问题连续发生的次数：把十个商品页都点一遍、每次都撞上"这个标签页不是商品页"，
 * 记成一条 `×10` 比记成十条一样的文本有用得多（既省地方，也一眼看出是重复还是不同问题）。
 */
export interface ErrorLogEntry {
  code: string;
  message: string;
  /** 最近一次发生的时间。 */
  at: number;
  /** 连续发生次数，至少 1。 */
  count: number;
}

/** 新的在前。 */
export type ErrorLog = readonly ErrorLogEntry[];

export const EMPTY_ERROR_LOG: ErrorLog = [];

function normalizeEntry(value: unknown): ErrorLogEntry | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code.trim() : '';
  const message = typeof record.message === 'string' ? record.message.trim() : '';
  if (message === '') return null;
  const at = typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0;
  const rawCount = typeof record.count === 'number' && Number.isFinite(record.count) ? record.count : 1;
  const count = Math.max(1, Math.floor(rawCount));
  return { code: code || 'E_UNKNOWN', message, at, count };
}

/**
 * 把存储里读到的任意值收成一张记录表。
 *
 * 规则与其它缓存一致：认不出来的条目直接丢（半条记录既不能显示也不能统计），
 * 按时间新的在前，最多 `ERROR_LOG_MAX` 条。
 */
export function parseErrorLog(value: unknown): ErrorLogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ErrorLogEntry[] = [];
  for (const item of value) {
    const entry = normalizeEntry(item);
    if (entry) entries.push(entry);
    if (entries.length >= ERROR_LOG_MAX) break;
  }
  return entries.sort((a, b) => b.at - a.at).slice(0, ERROR_LOG_MAX);
}

/**
 * 把一次失败并进记录表。
 *
 * 只和**最新那条**比对：同一个错误连续发生就累加次数，中间夹了别的错误则重开一条 ——
 * 「A、B、A」和「A 发生了两次」是两种现场，不该合并。
 */
export function mergeErrorEntry(
  log: ErrorLog,
  entry: { code: string; message: string; at: number },
): ErrorLogEntry[] {
  const next = normalizeEntry({ ...entry, count: 1 });
  if (!next) return [...log].slice(0, ERROR_LOG_MAX);
  const [head, ...rest] = log;
  if (head && head.code === next.code && head.message === next.message) {
    return [{ ...head, at: next.at, count: head.count + 1 }, ...rest].slice(0, ERROR_LOG_MAX);
  }
  return [next, ...log].slice(0, ERROR_LOG_MAX);
}

async function readRaw(): Promise<unknown> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEYS.errorLog);
    return stored?.[STORAGE_KEYS.errorLog];
  } catch {
    return undefined;
  }
}

export async function loadErrorLog(): Promise<ErrorLogEntry[]> {
  return parseErrorLog(await readRaw());
}

/**
 * 记下一次失败。
 *
 * 顺便把旧的 `aiee:last-error` 一起写掉（同一个 key 形状）：老版本插件读的是那一个键，
 * 多写一份 30 字节不值得为它单独留一条兼容分支。
 */
export async function appendError(entry: { code: string; message: string; at: number }): Promise<ErrorLogEntry[]> {
  const next = mergeErrorEntry(parseErrorLog(await readRaw()), entry);
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.errorLog]: next,
      [STORAGE_KEYS.lastError]: { code: entry.code, message: entry.message, at: entry.at },
    });
  } catch {
    /* 记不下来也不能影响主流程 */
  }
  return next;
}

export async function clearErrorLog(): Promise<void> {
  try {
    await chrome.storage.local.remove([STORAGE_KEYS.errorLog, STORAGE_KEYS.lastError]);
  } catch {
    /* ignore */
  }
}
