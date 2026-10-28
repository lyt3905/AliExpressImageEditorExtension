/**
 * LIVE contract test against the local vision gateway.
 *
 * Skipped unless explicitly enabled, so `npm run test` never touches the network:
 *
 *   AIEE_LIVE=1 AIEE_VISION_KEY=<key> npm run test:live
 *
 * What it proves:
 *
 * - the plumbing: URL, auth header, multi-image request shape,
 *   `response_format: json_object`, and that `parseBindingAnswer` can turn the real
 *   answer into material ids;
 * - the judgement, but only because the fixtures are deliberately unambiguous (a
 *   tall blue slab vs a brown two-panel box). A wrong pick here therefore means the
 *   prompt or the model changed, which is exactly what a contract test should say.
 *   If a model upgrade legitimately changes the call, update the fixture — do not
 *   weaken the assertion until it always passes.
 *
 * The two images are generated here rather than checked in, so the fixture can
 * never drift away from the assertion.
 */

import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { askVisionJson } from '../../src/services/vision-client';
import {
  bindMaterialsWithVision,
  buildBindingPrompt,
  parseBindingAnswer,
} from '../../src/services/composition/vision-binder';

const LIVE = process.env.AIEE_LIVE === '1';
const BASE_URL = process.env.AIEE_VISION_URL ?? 'http://127.0.0.1:8788/v1';
const MODEL = process.env.AIEE_VISION_MODEL ?? 'glm-5.3';
const API_KEY = process.env.AIEE_VISION_KEY ?? '';
const READY = LIVE && Boolean(API_KEY);

const TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------- PNG writer

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** Minimal RGBA PNG encoder — no dependency, no fixtures to keep in sync. */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function dataUrl(png: Buffer): string {
  return `data:image/png;base64,${png.toString('base64')}`;
}

function paint(
  width: number,
  height: number,
  painter: (x: number, y: number) => [number, number, number, number],
): Buffer {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = painter(x, y);
      const offset = (y * width + x) * 4;
      rgba[offset] = r;
      rgba[offset + 1] = g;
      rgba[offset + 2] = b;
      rgba[offset + 3] = a;
    }
  }
  return rgba;
}

/** A tall slab on white: reads as "one product, front view". */
function productPng(fill: [number, number, number] = [30, 90, 200]): string {
  const rgba = paint(320, 320, (x, y) => {
    const inside = x > 90 && x < 230 && y > 30 && y < 290;
    return inside ? [fill[0], fill[1], fill[2], 255] : [255, 255, 255, 255];
  });
  return dataUrl(encodePng(320, 320, rgba));
}

/** A white card with a ruled table: reads as "spec sheet, not a product". */
function specCardPng(): string {
  const rgba = paint(320, 320, (x, y) => {
    const border = (x > 40 && x < 280 && y > 60 && y < 260) &&
      (x < 46 || x > 274 || y < 66 || y > 254);
    const ruler = x > 60 && x < 260 && y > 100 && y < 250 && (y - 100) % 40 < 3;
    return border || ruler ? [0, 0, 0, 255] : [255, 255, 255, 255];
  });
  return dataUrl(encodePng(320, 320, rgba));
}

/** A brown slab with a lighter side panel: reads as "a box, seen at an angle". */
function boxPng(): string {
  const rgba = paint(320, 320, (x, y) => {
    const front = x > 70 && x < 210 && y > 90 && y < 260;
    const side = x >= 210 && x < 260 && y > 70 && y < 240;
    if (front) return [196, 150, 88, 255];
    if (side) return [160, 120, 66, 255];
    return [255, 255, 255, 255];
  });
  return dataUrl(encodePng(320, 320, rgba));
}

// ---------------------------------------------------------------- tests

describe.skipIf(!READY)('vision gateway (live)', () => {
  const config = { baseUrl: BASE_URL, model: MODEL, apiKey: API_KEY };

  it(
    'answers a multi-image request with parseable JSON',
    async () => {
      const candidates = [
        { materialId: 'm-product', label: '商品正面图', dataUrl: productPng() },
        { materialId: 'm-box', label: '包装图', dataUrl: boxPng() },
      ];

      const answer = await askVisionJson({
        config,
        prompt: buildBindingPrompt([
          { key: 'A', label: '商品正面图' },
          { key: 'B', label: '包装图' },
        ]),
        images: [
          { label: '图 A：', dataUrl: candidates[0].dataUrl },
          { label: '图 B：', dataUrl: candidates[1].dataUrl },
        ],
      });

      // eslint-disable-next-line no-console
      console.log(`[vision live] ${answer.elapsedMs} ms -> ${answer.text.slice(0, 200)}`);

      const binding = parseBindingAnswer(answer.json, [
        { key: 'A', materialId: 'm-product' },
        { key: 'B', materialId: 'm-box' },
      ]);
      expect(binding, '模型答案无法映射回素材，说明协议变了').not.toBeNull();
      expect(binding!.confidence).toBeGreaterThanOrEqual(0);
      expect(binding!.confidence).toBeLessThanOrEqual(1);
    },
    TIMEOUT_MS,
  );

  it(
    'binds roles end to end through the binder',
    async () => {
      const binding = await bindMaterialsWithVision({
        configs: [config],
        candidates: [
          { materialId: 'm-product', label: '商品正面图', dataUrl: productPng() },
          { materialId: 'm-box', label: '包装图', dataUrl: boxPng() },
        ],
      });

      // eslint-disable-next-line no-console
      console.log('[vision live] binding', JSON.stringify(binding));
      expect(binding).not.toBeNull();
      expect(binding!.heroId).toBe('m-product');
    },
    TIMEOUT_MS,
  );

  it(
    'still finds the package when it is the fifth of six images',
    async () => {
      // The cap question in one test: 6 is what a product page can hold, and the
      // package photo is often the last one. Four distractors in front of it.
      const binding = await bindMaterialsWithVision({
        configs: [config],
        candidates: [
          { materialId: 'm-product', label: '商品正面图', dataUrl: productPng([30, 90, 200]) },
          { materialId: 'm-back', label: '商品背面图', dataUrl: productPng([30, 140, 90]) },
          { materialId: 'm-detail', label: '细节图', dataUrl: productPng([180, 60, 40]) },
          { materialId: 'm-spec', label: '参数图', dataUrl: specCardPng() },
          { materialId: 'm-box', label: '包装图', dataUrl: boxPng() },
          { materialId: 'm-filler', label: '补白图', dataUrl: productPng([120, 120, 120]) },
        ],
      });

      // eslint-disable-next-line no-console
      console.log('[vision live] six-image binding', JSON.stringify(binding));
      expect(binding).not.toBeNull();
      expect(binding!.boxId).toBe('m-box');
      expect(binding!.heroId).not.toBe('m-box');
    },
    TIMEOUT_MS,
  );
});
