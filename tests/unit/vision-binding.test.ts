import { describe, expect, it } from 'vitest';
import {
  askVisionJson,
  parseJsonLoose,
  VisionError,
  type FetchLike,
} from '../../src/services/vision-client';
import {
  bindMaterialsWithVision,
  buildBindingPrompt,
  parseBindingAnswer,
  selectVisionCandidates,
  type VisionCandidate,
} from '../../src/services/composition/vision-binder';
import type { VisionSettings } from '../../src/services/settings';

const CONFIG: VisionSettings = {
  baseUrl: 'http://127.0.0.1:8788/v1',
  model: 'glm-5.3',
  apiKey: 'test-key',
};

interface Captured {
  url: string;
  body: Record<string, any>;
  headers: Record<string, string>;
}

function fakeFetch(answer: unknown, options: { status?: number; raw?: string } = {}): { impl: FetchLike; captured: Captured } {
  const captured: Captured = { url: '', body: {}, headers: {} };
  const impl: FetchLike = async (input, init) => {
    captured.url = String(input);
    captured.body = JSON.parse(String(init?.body ?? '{}'));
    captured.headers = (init?.headers ?? {}) as Record<string, string>;
    if (options.raw !== undefined) {
      return new Response(options.raw, { status: options.status ?? 200 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: typeof answer === 'string' ? answer : JSON.stringify(answer) } }],
      }),
      { status: options.status ?? 200, headers: { 'Content-Type': 'application/json' } },
    );
  };
  return { impl, captured };
}

describe('askVisionJson', () => {
  it('sends the verified request shape', async () => {
    const { impl, captured } = fakeFetch({ ok: true });
    const answer = await askVisionJson({
      config: CONFIG,
      prompt: '判断角色',
      images: [
        { label: '图 A：', dataUrl: 'data:image/png;base64,AAA' },
        { label: '图 B：', dataUrl: 'data:image/png;base64,BBB' },
      ],
      fetchImpl: impl,
    });

    expect(captured.url).toBe('http://127.0.0.1:8788/v1/chat/completions');
    expect(captured.body.model).toBe('glm-5.3');
    // temperature 0: the same product has to bind the same way twice.
    expect(captured.body.temperature).toBe(0);
    expect(captured.body.response_format).toEqual({ type: 'json_object' });
    expect(captured.headers.Authorization).toBe('Bearer test-key');

    const content = captured.body.messages[0].content as Array<Record<string, any>>;
    expect(content[0]).toEqual({ type: 'text', text: '判断角色' });
    expect(content[1]).toEqual({ type: 'text', text: '图 A：' });
    expect(content[2]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
    expect(answer.json).toEqual({ ok: true });
  });

  it('omits the Authorization header when no key is configured', async () => {
    const { impl, captured } = fakeFetch({ ok: true });
    await askVisionJson({
      config: { ...CONFIG, apiKey: '' },
      prompt: 'p',
      images: [],
      fetchImpl: impl,
    });
    expect(captured.headers.Authorization).toBeUndefined();
  });

  it('reports 401 as an auth error without echoing the key', async () => {
    const { impl } = fakeFetch('nope', { status: 401, raw: 'unauthorized' });
    const error = await askVisionJson({ config: CONFIG, prompt: 'p', images: [], fetchImpl: impl }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(VisionError);
    expect((error as VisionError).code).toBe('auth');
    expect((error as VisionError).message).not.toContain('test-key');
  });

  it('reports a 5xx as a server error with a short snippet', async () => {
    const { impl } = fakeFetch('', { status: 503, raw: 'gateway down' });
    const error = (await askVisionJson({ config: CONFIG, prompt: 'p', images: [], fetchImpl: impl }).catch(
      (caught: unknown) => caught,
    )) as VisionError;
    expect(error.code).toBe('server');
    expect(error.message).toContain('503');
    expect(error.message).toContain('gateway down');
  });

  it('reports a missing message.content as a bad response', async () => {
    const { impl } = fakeFetch('', { raw: JSON.stringify({ choices: [{ message: {} }] }) });
    const error = (await askVisionJson({ config: CONFIG, prompt: 'p', images: [], fetchImpl: impl }).catch(
      (caught: unknown) => caught,
    )) as VisionError;
    expect(error.code).toBe('bad_response');
  });

  it('times out instead of hanging on a stalled gateway', async () => {
    const hanging: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        });
      });
    const error = (await askVisionJson({
      config: CONFIG,
      prompt: 'p',
      images: [],
      fetchImpl: hanging,
      timeoutMs: 5,
    }).catch((caught: unknown) => caught)) as VisionError;
    expect(error.code).toBe('timeout');
  });

  it('surfaces a transport failure as a network error naming the endpoint', async () => {
    const failing: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const error = (await askVisionJson({ config: CONFIG, prompt: 'p', images: [], fetchImpl: failing }).catch(
      (caught: unknown) => caught,
    )) as VisionError;
    expect(error.code).toBe('network');
    expect(error.message).toContain('127.0.0.1:8788');
  });
});

describe('parseJsonLoose', () => {
  it('accepts bare JSON', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a ```json fence', () => {
    expect(parseJsonLoose('```json\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('recovers from a sentence of preamble', () => {
    expect(parseJsonLoose('好的，结果是 {"a":3}')).toEqual({ a: 3 });
  });

  it('throws a typed error on prose', () => {
    try {
      parseJsonLoose('我看不出这是什么');
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as VisionError).code).toBe('bad_response');
    }
  });
});

describe('parseBindingAnswer', () => {
  const candidates = [
    { key: 'A', materialId: 'm-hero' },
    { key: 'B', materialId: 'm-box' },
  ];

  it('maps keys back to material ids', () => {
    const binding = parseBindingAnswer(
      { hero: 'A', package: 'B', hero_confidence: 0.9, package_found: true, reason: 'A 是主体' },
      candidates,
    );
    expect(binding).toEqual({
      heroId: 'm-hero',
      boxId: 'm-box',
      confidence: 0.9,
      reason: 'A 是主体',
    });
  });

  it('treats package_found=false as "no package", even with a letter', () => {
    const binding = parseBindingAnswer(
      { hero: 'A', package: 'B', hero_confidence: 0.5, package_found: false, reason: '无包装' },
      candidates,
    );
    expect(binding?.boxId).toBeNull();
  });

  it('refuses to let one material be both roles', () => {
    const binding = parseBindingAnswer(
      { hero: 'A', package: 'A', hero_confidence: 0.5, package_found: true, reason: '-' },
      candidates,
    );
    expect(binding?.boxId).toBeNull();
  });

  it('returns null when the hero letter is unknown', () => {
    expect(parseBindingAnswer({ hero: 'Z', package_found: true }, candidates)).toBeNull();
    expect(parseBindingAnswer({ hero: 42 }, candidates)).toBeNull();
    expect(parseBindingAnswer(null, candidates)).toBeNull();
    expect(parseBindingAnswer('A', candidates)).toBeNull();
  });

  it('clamps confidence and supplies a reason when missing', () => {
    const binding = parseBindingAnswer({ hero: 'A', package_found: false, hero_confidence: 4 }, candidates);
    expect(binding?.confidence).toBe(1);
    expect(binding?.reason).toBe('模型未给出理由');
  });

  it('accepts lowercase and prefixed letters', () => {
    const binding = parseBindingAnswer({ hero: '图a', package: 'b', package_found: true }, candidates);
    expect(binding?.heroId).toBe('m-hero');
    expect(binding?.boxId).toBe('m-box');
  });
});

describe('bindMaterialsWithVision', () => {
  const candidates: VisionCandidate[] = [
    { materialId: 'm1', label: '商品正面图', dataUrl: 'data:image/png;base64,1' },
    { materialId: 'm2', label: '包装图', dataUrl: 'data:image/png;base64,2' },
  ];

  it('turns a model answer into material ids', async () => {
    const { impl, captured } = fakeFetch({
      hero: 'A',
      package: 'B',
      hero_confidence: 0.9,
      package_found: true,
      reason: 'A 清晰适合特写',
    });
    const binding = await bindMaterialsWithVision({ config: CONFIG, candidates, fetchImpl: impl });

    expect(binding?.heroId).toBe('m1');
    expect(binding?.boxId).toBe('m2');
    // Labels travel with the images so the model can use page context.
    expect(JSON.stringify(captured.body)).toContain('商品正面图');
  });

  it('sends every candidate when the page has no more than the slot count', async () => {
    // Six is the number of image slots AliExpress exposes, so this is the normal
    // case — and it must NOT be trimmed: the package photo is often slot 5 or 6.
    const six: VisionCandidate[] = Array.from({ length: 6 }, (_unused, index) => ({
      materialId: `m${index}`,
      label: `图${index}`,
      dataUrl: `data:image/png;base64,${index}`,
    }));
    const { impl, captured } = fakeFetch({ hero: 'A', package_found: false });
    await bindMaterialsWithVision({ config: CONFIG, candidates: six, fetchImpl: impl });
    const content = captured.body.messages[0].content as unknown[];
    // prompt + (label + image) per candidate
    expect(content).toHaveLength(1 + 6 * 2);
  });

  it('keeps the packaging photo when there are more candidates than slots', async () => {
    const many: VisionCandidate[] = [
      { materialId: 'a', label: '商品正面图', dataUrl: 'data:image/png;base64,0' },
      { materialId: 'b', label: '商品背面图', dataUrl: 'data:image/png;base64,1' },
      { materialId: 'c', label: '细节图1', dataUrl: 'data:image/png;base64,2' },
      { materialId: 'd', label: '细节图2', dataUrl: 'data:image/png;base64,3' },
      { materialId: 'e', label: '场景图', dataUrl: 'data:image/png;base64,4' },
      { materialId: 'f', label: '包装图', dataUrl: 'data:image/png;base64,5' },
      { materialId: 'g', label: '补白图', dataUrl: 'data:image/png;base64,6' },
    ];
    const { impl, captured } = fakeFetch({ hero: 'A', package_found: false });
    await bindMaterialsWithVision({ config: CONFIG, candidates: many, fetchImpl: impl });

    const content = captured.body.messages[0].content as Array<Record<string, unknown>>;
    expect(content).toHaveLength(1 + 6 * 2);
    // A naive "first six" would have dropped 包装图 — the one role the model is for.
    expect(JSON.stringify(content)).toContain('包装图');
    expect(JSON.stringify(content)).not.toContain('补白图');
  });

  it('returns null without spending a request when there is nothing to send', async () => {
    let called = false;
    const impl: FetchLike = async () => {
      called = true;
      return new Response('{}');
    };
    expect(await bindMaterialsWithVision({ config: CONFIG, candidates: [], fetchImpl: impl })).toBeNull();
    expect(called).toBe(false);
  });

  it('returns null when the answer names no usable hero', async () => {
    const { impl } = fakeFetch({ hero: null, package_found: false });
    expect(await bindMaterialsWithVision({ config: CONFIG, candidates, fetchImpl: impl })).toBeNull();
  });
});

describe('selectVisionCandidates', () => {
  const make = (label: string, id = label) => ({ materialId: id, label });

  it('keeps everything when the list already fits', () => {
    const list = [make('正面'), make('背面'), make('包装')];
    expect(selectVisionCandidates(list)).toEqual(list);
  });

  it('drops the least informative extras, not the tail of the list', () => {
    const list = [
      make('正面'), make('背面'), make('细节1'), make('细节2'), make('场景'), make('包装'), make('补白'),
    ];
    const chosen = selectVisionCandidates(list);
    expect(chosen).toHaveLength(6);
    expect(chosen.map((entry) => entry.label)).toContain('包装');
    expect(chosen.map((entry) => entry.label)).not.toContain('补白');
  });

  it('preserves page order in the chosen list, so A/B/C still read left to right', () => {
    const list = [make('正面'), make('背面'), make('细节1'), make('细节2'), make('包装'), make('细节3'), make('细节4')];
    const chosen = selectVisionCandidates(list);
    expect(chosen.map((entry) => entry.label)).toEqual(['正面', '背面', '细节1', '细节2', '包装', '细节3']);
  });

  it('falls back to page order when nothing looks like packaging', () => {
    const list = Array.from({ length: 8 }, (_unused, index) => make(`图${index}`));
    expect(selectVisionCandidates(list).map((entry) => entry.label)).toEqual([
      '图0', '图1', '图2', '图3', '图4', '图5',
    ]);
  });

  it('honours a custom limit', () => {
    const list = [make('正面'), make('包装'), make('细节')];
    expect(selectVisionCandidates(list, 2).map((entry) => entry.label)).toEqual(['正面', '包装']);
  });

  it('does not mutate the input array', () => {
    const list = [make('正面'), make('包装'), make('细节')];
    const before = list.map((entry) => entry.label);
    selectVisionCandidates(list, 2);
    expect(list.map((entry) => entry.label)).toEqual(before);
  });
});

describe('buildBindingPrompt', () => {
  it('lists every candidate by key and label, and spells out the no-package case', () => {
    const prompt = buildBindingPrompt([
      { key: 'A', label: '商品正面图' },
      { key: 'B', label: '包装图' },
    ]);
    expect(prompt).toContain('A（商品正面图）');
    expect(prompt).toContain('B（包装图）');
    expect(prompt).toContain('package_found');
    expect(prompt).toContain('null');
  });
});
