import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_VISION_API_KEY, DEFAULT_VISION_MODEL } from '../../src/shared/constants';
import type { VisionEndpoint, VisionSettings } from '../../src/services/settings';
import { VisionError, type FetchLike } from '../../src/services/vision-client';
import {
  askVisionWithFallback,
  orderByPin,
  resolveVisionConfigs,
} from '../../src/services/vision-endpoints';

const MAIN = 'http://127.0.0.1:8788/v1';
const BACKUP = 'http://10.0.0.9:8788/v1';

function config(baseUrl: string, model = 'glm-5.3', apiKey = 'k'): VisionSettings {
  return { baseUrl, model, apiKey };
}

/** Answers per base URL: a `Response` factory, or an error to throw. */
function routedFetch(
  routes: Record<string, () => Response | Error>,
): { impl: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const impl: FetchLike = async (input) => {
    const url = String(input);
    calls.push(url);
    const base = Object.keys(routes).find((candidate) => url.startsWith(candidate));
    if (!base) throw new Error(`unexpected url ${url}`);
    const outcome = routes[base]!();
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return { impl, calls };
}

function okResponse(answer: unknown = { hero: 'A' }): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: JSON.stringify(answer) } }],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function ports(pinned = ''): {
  loadPin: () => Promise<string>;
  savePin: (baseUrl: string) => Promise<void>;
  saved: string[];
} {
  const saved: string[] = [];
  return {
    loadPin: async () => pinned,
    savePin: async (baseUrl: string) => {
      saved.push(baseUrl);
    },
    saved,
  };
}

describe('resolveVisionConfigs', () => {
  it('lets a backup row inherit the model and key from the first row', () => {
    const endpoints: VisionEndpoint[] = [
      { baseUrl: MAIN, model: 'glm-5.3', apiKey: 'main-key' },
      { baseUrl: BACKUP, model: '', apiKey: '' },
    ];
    expect(resolveVisionConfigs(endpoints)).toEqual([
      { baseUrl: MAIN, model: 'glm-5.3', apiKey: 'main-key' },
      { baseUrl: BACKUP, model: 'glm-5.3', apiKey: 'main-key' },
    ]);
  });

  it('keeps a row that states its own model and key', () => {
    const endpoints: VisionEndpoint[] = [
      { baseUrl: MAIN, model: 'glm-5.3', apiKey: 'main-key' },
      { baseUrl: BACKUP, model: 'qwen-vl-max', apiKey: 'backup-key' },
    ];
    expect(resolveVisionConfigs(endpoints)[1]).toEqual({
      baseUrl: BACKUP,
      model: 'qwen-vl-max',
      apiKey: 'backup-key',
    });
  });

  it('fills the gap from the build-time defaults when the first row is bare', () => {
    // An empty key has always meant "use the built-in one"; inheriting must not
    // turn it into "send no Authorization header".
    const configs = resolveVisionConfigs([{ baseUrl: MAIN, model: '', apiKey: '' }]);
    expect(configs).toEqual([
      { baseUrl: MAIN, model: DEFAULT_VISION_MODEL, apiKey: DEFAULT_VISION_API_KEY },
    ]);
  });

  it('returns nothing for an empty chain', () => {
    expect(resolveVisionConfigs([])).toEqual([]);
  });
});

describe('orderByPin', () => {
  it('moves the pinned gateway to the front and keeps the rest in order', () => {
    const ordered = orderByPin([config(MAIN), config(BACKUP), config('http://c/v1')], BACKUP);
    expect(ordered.map((one) => one.baseUrl)).toEqual([BACKUP, MAIN, 'http://c/v1']);
  });

  it('leaves the order alone when the pinned gateway is gone', () => {
    // Unplugging the backup should not reshuffle anything — the pin still points
    // at an address the user removed.
    const ordered = orderByPin([config(MAIN), config(BACKUP)], 'http://gone/v1');
    expect(ordered.map((one) => one.baseUrl)).toEqual([MAIN, BACKUP]);
  });

  it('returns a fresh array so callers cannot mutate the stored list', () => {
    const source = [config(MAIN)];
    const ordered = orderByPin(source, '');
    expect(ordered).toEqual(source);
    expect(ordered).not.toBe(source);
  });
});

describe('askVisionWithFallback', () => {
  it('moves on to the next gateway when the first one fails', async () => {
    const { impl, calls } = routedFetch({
      [MAIN]: () => new Response('boom', { status: 500 }),
      [BACKUP]: () => okResponse({ hero: 'B' }),
    });
    const pin = ports();

    const result = await askVisionWithFallback({
      configs: [config(MAIN), config(BACKUP)],
      prompt: 'p',
      images: [],
      fetchImpl: impl,
      ports: pin,
    });

    expect(calls).toHaveLength(2);
    expect(result.config.baseUrl).toBe(BACKUP);
    expect(result.attempts.map((attempt) => attempt.baseUrl)).toEqual([MAIN, BACKUP]);
    expect(result.attempts[0]!.code).toBe('server');
    expect(result.attempts[1]!.code).toBe('ok');
    // Only the answerer is pinned.
    expect(pin.saved).toEqual([BACKUP]);
  });

  it('stops after the first gateway when it answers', async () => {
    const { impl, calls } = routedFetch({
      [MAIN]: () => okResponse(),
      [BACKUP]: () => okResponse(),
    });
    const pin = ports();

    await askVisionWithFallback({
      configs: [config(MAIN), config(BACKUP)],
      prompt: 'p',
      images: [],
      fetchImpl: impl,
      ports: pin,
    });

    expect(calls).toHaveLength(1);
    expect(pin.saved).toEqual([MAIN]);
  });

  it('tries the pinned gateway first even when it is not the first row', async () => {
    const { impl, calls } = routedFetch({
      [MAIN]: () => okResponse(),
      [BACKUP]: () => okResponse(),
    });
    const pin = ports(BACKUP);

    const result = await askVisionWithFallback({
      configs: [config(MAIN), config(BACKUP)],
      prompt: 'p',
      images: [],
      fetchImpl: impl,
      ports: pin,
    });

    expect(calls[0]).toContain(BACKUP);
    expect(result.config.baseUrl).toBe(BACKUP);
  });

  it('rethrows the first error, with the others appended, when everything fails', async () => {
    // Real failures, not thrown ones: a 401 from the main gateway and a DNS
    // failure on the backup. `askVisionJson` normalises both into VisionError.
    const { impl } = routedFetch({
      [MAIN]: () => new Response('unauthorized', { status: 401 }),
      [BACKUP]: () => new TypeError('Failed to fetch'),
    });

    const error = await askVisionWithFallback({
      configs: [config(MAIN), config(BACKUP)],
      prompt: 'p',
      images: [],
      fetchImpl: impl,
      ports: ports(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VisionError);
    const failure = error as VisionError;
    // The first row is what the user thinks of as "the gateway", so its code and
    // status are the ones that survive.
    expect(failure.code).toBe('auth');
    expect(failure.status).toBe(401);
    expect(failure.message).toContain('拒绝访问');
    expect(failure.message).toContain('10.0.0.9:8788');
  });

  it('counts an unreachable gateway as one more failure to skip', async () => {
    // A DNS failure surfaces as a plain TypeError from fetch, not a VisionError.
    const { impl } = routedFetch({
      [MAIN]: () => new TypeError('Failed to fetch'),
      [BACKUP]: () => okResponse(),
    });

    const result = await askVisionWithFallback({
      configs: [config(MAIN), config(BACKUP)],
      prompt: 'p',
      images: [],
      fetchImpl: impl,
      ports: ports(),
    });

    expect(result.config.baseUrl).toBe(BACKUP);
    expect(result.attempts[0]!.code).toBe('network');
    expect(result.attempts[0]!.message).toContain('Failed to fetch');
  });

  it('refuses an empty chain instead of pretending to call anything', async () => {
    const { impl, calls } = routedFetch({});

    const error = await askVisionWithFallback({
      configs: [],
      prompt: 'p',
      images: [],
      fetchImpl: impl,
      ports: ports(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(VisionError);
    expect((error as VisionError).code).toBe('network');
    expect((error as VisionError).message).toContain('没有配置视觉接口');
    expect(calls).toHaveLength(0);
  });

  it('still answers when the pin store is broken', async () => {
    const { impl } = routedFetch({ [MAIN]: () => okResponse() });
    const savePin = vi.fn(async () => {
      throw new Error('storage unavailable');
    });

    const result = await askVisionWithFallback({
      configs: [config(MAIN)],
      prompt: 'p',
      images: [],
      fetchImpl: impl,
      ports: {
        loadPin: async () => {
          throw new Error('storage unavailable');
        },
        savePin,
      },
    });

    expect(result.config.baseUrl).toBe(MAIN);
    expect(savePin).toHaveBeenCalledWith(MAIN);
  });
});
