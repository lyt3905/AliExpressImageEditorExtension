/**
 * 「画布上到底画了什么」的指纹，用来给成品 PNG 做缓存键。
 *
 * 为什么不能拿"排版计划"当键（2026-11-03 复核 R6）：计划只描述生成那一刻的意图，
 * 之后用户还可以改不透明度、加发光、拖位置、换水印、挪品牌 Logo、改编号文字 —— 那些
 * 全都改变成品像素，却不在计划里。于是"下载缓存成品"给出的是上一版。
 *
 * 所以键从**当前文档**算：图层按绘制顺序（数组顺序 = z 序）逐个出指纹，图片带身份、
 * 几何与效果渲染签名，文字带内容与全部排版字段，衬板带几何与颜色；再加上水印。
 * 任何一项改动都会换键，旧条目自然就命不中了 —— 不需要"记住哪些操作要清缓存"。
 */

import type { EditorLayer, WatermarkLayer } from '../../shared/types';
import { imageRenderSignature } from '../../services/image-effects';

/** 一位数就够用的小数往返，避免 0.30000000000000004 这类噪声进键。 */
function round(value: number | undefined, digits = 3): string {
  if (!Number.isFinite(value)) return '0';
  const factor = 10 ** digits;
  return String(Math.round((value as number) * factor) / factor);
}

function geometryOf(layer: EditorLayer | WatermarkLayer): string {
  return [
    round(layer.x),
    round(layer.y),
    round(layer.scale, 4),
    round(layer.rotation),
    layer.flipX ? 'fx' : '',
    layer.flipY ? 'fy' : '',
  ]
    .filter((part) => part !== '')
    .join(',');
}

function picturePart(
  layer: EditorLayer,
  identityByMaterialId: ReadonlyMap<string, string>,
): string {
  /*
    Never let a missing identity collapse to "": that made two different logos (or two
    different original photos) with the same geometry share one key — the cache then
    hands back a PNG painted with the OLD material (2026-11-03 复核 R6 第二个反例).
    `blobId` is per-material content, so it separates them even when the identity map
    has nothing to say about this layer.
  */
  const materialId = (layer as { materialId?: string }).materialId ?? '';
  const blobId = (layer as { blobId?: string }).blobId ?? '';
  const identity =
    identityByMaterialId.get(materialId) ??
    (blobId ? `blob:${blobId}` : `material:${materialId || layer.id}`);
  const kind = layer.kind;
  const effects =
    layer.kind === 'text' || layer.kind === 'plate' ? '' : imageRenderSignature(layer.effects);
  return `pic:${kind}:${identity}@${geometryOf(layer)}#${effects}`;
}

function textPart(layer: Extract<EditorLayer, { kind: 'text' }>): string {
  return [
    'text:',
    layer.text,
    `@${geometryOf(layer)}`,
    `w${round(layer.width, 2)}`,
    `fs${round(layer.fontSize, 2)}`,
    layer.fontFamily,
    layer.fill,
    layer.fontStyle,
    layer.align,
    `sw${round(layer.strokeWidth, 2)}`,
    layer.stroke,
    `sh${layer.shadowColor},${round(layer.shadowBlur, 2)},${round(layer.shadowOffsetX, 2)},${round(
      layer.shadowOffsetY,
      2,
    )},${round(layer.shadowOpacity)}`,
  ].join('|');
}

function platePart(layer: Extract<EditorLayer, { kind: 'plate' }>): string {
  return [
    'plate:',
    layer.fill,
    `@${geometryOf(layer)}`,
    `w${round(layer.width, 2)}x${round(layer.height, 2)}`,
    `r${round(layer.cornerRadius, 2)}`,
  ].join('|');
}

/**
 * 品牌 Logo 的画布身份。
 *
 * 目录同步会**用同一个 blob id 覆盖内容**（`applyBrandSync()` 就是这么做的）：同一个品牌
 * 发了 v2 的 Logo，blobId 不变，只看 blobId 的话"换了内容"和"没换"是同一个键 ——
 * 2026-11-03 三次复核 R6 的反例（v1 → v2 都是 `fae2680b`）。所以身份必须带上内容版本：
 * 远端品牌用 `remoteRev`，手工上传的品牌没有 rev（重新上传会换 blobId，本身就有区分度）。
 */
export function brandPaintIdentity(
  materialId: string,
  revision: string | undefined,
  blobId: string,
): string {
  const version = (revision ?? '').trim();
  return `brand:${materialId}:${version}:${blobId}`;
}

/**
 * 逐层的指纹片段，顺序即绘制顺序。
 *
 * 返回数组而不是拼好的字符串：调用方把它交给 `hashKey()`，两者都用 `\u0000` 分隔，
 * 于是「['ab','c']」与「['a','bc']」不会撞在一起。
 */
export function paintParts(
  layers: readonly EditorLayer[],
  identityByMaterialId: ReadonlyMap<string, string>,
  watermark: WatermarkLayer | null,
): string[] {
  const parts: string[] = [];
  if (watermark) {
    parts.push(`watermark:${watermark.blobId}@${geometryOf(watermark)}`);
  }
  for (const layer of layers) {
    if (layer.kind === 'text') parts.push(textPart(layer));
    else if (layer.kind === 'plate') parts.push(platePart(layer));
    else parts.push(picturePart(layer, identityByMaterialId));
  }
  return parts;
}

/**
 * 没有任何图片图层时返回 `null`：一张成品里连图都没有，缓存它没有意义，
 * 调用方（下载 / 缓存提示）也该当成"没有可下载的成品"。
 */
export function paintFingerprintOf(
  layers: readonly EditorLayer[],
  identityByMaterialId: ReadonlyMap<string, string>,
  watermark: WatermarkLayer | null,
): string[] | null {
  const hasPicture = layers.some((layer) => layer.kind !== 'text' && layer.kind !== 'plate');
  if (!hasPicture) return null;
  return paintParts(layers, identityByMaterialId, watermark);
}
