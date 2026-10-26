/**
 * Minimal client for the local OpenAI-compatible vision gateway.
 *
 * Verified against the real gateway before writing this (see the compose feature
 * notes): `glm-5.3` accepts several images in ONE message, honours
 * `response_format: {type:'json_object'}`, and answers in ~4.5 s for two 512px
 * images. Both of those facts are load-bearing here — one request per binding
 * instead of one per image, and no prose to strip.
 *
 * Deliberately NOT reusing `services/server-api.ts`: that client speaks the Toy
 * Item Prod server's cookie auth and its two different response envelopes. Sharing
 * would blur both contracts for no gain.
 */

import { VISION_TIMEOUT_MS } from '../shared/constants';
import type { VisionSettings } from './settings';

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export type VisionErrorCode = 'network' | 'auth' | 'timeout' | 'server' | 'bad_response';

export class VisionError extends Error {
  constructor(
    readonly code: VisionErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'VisionError';
  }
}

export interface VisionImageInput {
  /** Short label shown to the model right before the image, e.g. `图 A：`. */
  label: string;
  /** `data:image/...;base64,...` */
  dataUrl: string;
}

export interface AskVisionOptions {
  config: VisionSettings;
  prompt: string;
  images: VisionImageInput[];
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

export interface VisionAnswer {
  json: unknown;
  text: string;
  elapsedMs: number;
}

function endpoint(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return `${base}/chat/completions`;
}

/**
 * Pull a JSON object out of a chat completion.
 *
 * `json_object` mode returns bare JSON in practice, but a model that wraps it in a
 * ``` fence or adds one sentence of preamble is a normal Tuesday. Slicing from the
 * first `{` to the last `}` costs nothing and turns "cannot parse" into a working
 * answer.
 */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new VisionError('bad_response', '模型返回了空内容');
  const fenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const candidates = [fenced, trimmed];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try the next form */
    }
  }
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(fenced.slice(start, end + 1));
    } catch {
      /* fall through */
    }
  }
  throw new VisionError('bad_response', `模型返回的不是 JSON：${fenced.slice(0, 120)}`);
}

export async function askVisionJson(options: AskVisionOptions): Promise<VisionAnswer> {
  const { config, prompt, images, timeoutMs = VISION_TIMEOUT_MS } = options;
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (!fetchImpl) throw new VisionError('network', '当前环境不支持 fetch');
  if (!config.model) throw new VisionError('bad_response', '未配置视觉模型名称');

  const content: Array<Record<string, unknown>> = [{ type: 'text', text: prompt }];
  for (const image of images) {
    content.push({ type: 'text', text: image.label });
    content.push({ type: 'image_url', image_url: { url: image.dataUrl } });
  }

  const body = {
    model: config.model,
    messages: [{ role: 'user', content }],
    // Determinism matters: the same product must bind the same way twice, otherwise
    // a regenerated layout silently differs from the one the seller approved.
    temperature: 0,
    max_tokens: 400,
    response_format: { type: 'json_object' },
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Some local gateways do not check a key at all; sending an empty Bearer would be
  // worse than sending none.
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    let response: Response;
    try {
      response = await fetchImpl(endpoint(config.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new VisionError('timeout', `视觉接口超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      const name = (error as { name?: string } | null)?.name;
      if (name === 'AbortError') {
        throw new VisionError('timeout', `视觉接口超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }
      throw new VisionError(
        'network',
        `无法连接视觉接口 ${endpoint(config.baseUrl)}：${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const raw = await response.text();
    if (response.status === 401 || response.status === 403) {
      /*
        Two different causes with two different fixes. The generic "请检查 API Key"
        said nothing when the real problem was that no key existed at all — which is
        exactly what happened on the first real run: the request reached the gateway
        (so network and host permissions were fine), and the 401 was the only clue
        that the Authorization header had been omitted.
      */
      throw new VisionError(
        'auth',
        config.apiKey
          ? `视觉接口拒绝访问（HTTP ${response.status}）：Key 无效或已过期，请到选项页更新`
          : `视觉接口要求鉴权（HTTP ${response.status}），但当前没有配置 Key：请在选项页填写「视觉接口 Key」`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new VisionError(
        'server',
        `视觉接口返回 HTTP ${response.status}：${raw.slice(0, 200)}`,
        response.status,
      );
    }

    let envelope: { choices?: Array<{ message?: { content?: unknown } }> };
    try {
      envelope = JSON.parse(raw) as typeof envelope;
    } catch {
      throw new VisionError('bad_response', `视觉接口返回的不是 JSON：${raw.slice(0, 160)}`);
    }
    const contentText = envelope.choices?.[0]?.message?.content;
    if (typeof contentText !== 'string' || !contentText.trim()) {
      throw new VisionError('bad_response', '视觉接口的响应里没有 message.content');
    }

    return { json: parseJsonLoose(contentText), text: contentText, elapsedMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}
