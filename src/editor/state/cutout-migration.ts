import type { SessionImage } from '../../shared/types';

/**
 * 这份已经存在的抠图，还能不能当作是"这张原图的"抠图？
 *
 * 10.22.2 给旧会话补了内容摘要，但没有核对已经写下的 `cutoutBlobId` 属于谁 ——
 * 于是"上一个版本补过摘要的错图会话"会原样留在 success：摘要对了，抠图仍是别的商品的
 * （2026-11-03 三次复核 R2）。判断依据必须是**独立的迁移事实**，而不是"有没有摘要"：
 *
 * - `cutoutDigest` 是这份抠图生成时所用原图的摘要，10.22.3 起才会写。老记录没有它，
 *   一律不能作数 —— 宁可重抠一次，也不把别人的抠图端上台面。
 * - 连原图摘要都没有（`crypto.subtle` 不可用）时同样不作数：那种情况下身份只在本次
 *   会话内成立，无从证明这份 blob 属于这张图。
 *
 * 只在恢复会话时调用，所以"重抠一次"的代价只落在升级后的第一次打开。
 */
export function cutoutNeedsRework(
  image: Pick<SessionImage, 'cutoutStatus' | 'digest' | 'cutoutDigest'>,
): boolean {
  if (image.cutoutStatus !== 'success') return false;
  const digest = (image.digest ?? '').trim().toLowerCase();
  if (!digest) return true;
  return (image.cutoutDigest ?? '').trim().toLowerCase() !== digest;
}
