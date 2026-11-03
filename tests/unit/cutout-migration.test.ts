/**
 * 恢复会话时"这份抠图还算不算这张图的" —— 2026-11-03 三次复核 R2。
 *
 * 上一版只给旧会话补内容摘要，没有核对已经写下的 `cutoutBlobId` 属于谁，于是
 * "10.22.2 补过摘要、但抠图是别人家的"会话会一直留在 success。判据必须独立于摘要：
 * 只有记录里写明了这份抠图出自哪张原图（`cutoutDigest`）且与当前原图一致时才算数。
 */

import { describe, expect, it } from 'vitest';
import { cutoutNeedsRework } from '../../src/editor/state/cutout-migration';

const DIGEST = 'a'.repeat(64);

describe('cutoutNeedsRework', () => {
  it('leaves a cut-out that records the same source digest alone', () => {
    expect(
      cutoutNeedsRework({ cutoutStatus: 'success', digest: DIGEST, cutoutDigest: DIGEST }),
    ).toBe(false);
  });

  it('re-cuts a success record written before cutoutDigest existed', () => {
    // 10.22.2 的迁移逻辑留下的正是这个形状：摘要补上了，抠图归属没有。
    expect(cutoutNeedsRework({ cutoutStatus: 'success', digest: DIGEST })).toBe(true);
  });

  it('re-cuts when the recorded cut-out came from another image', () => {
    expect(
      cutoutNeedsRework({ cutoutStatus: 'success', digest: DIGEST, cutoutDigest: 'b'.repeat(64) }),
    ).toBe(true);
  });

  it('re-cuts when the source digest is unknown — identity is only session-local then', () => {
    expect(cutoutNeedsRework({ cutoutStatus: 'success' })).toBe(true);
  });

  it('ignores anything that is not a finished cut-out', () => {
    for (const status of ['idle', 'processing', 'failed'] as const) {
      expect(cutoutNeedsRework({ cutoutStatus: status, digest: DIGEST })).toBe(false);
    }
  });

  it('compares digests case-insensitively and ignores padding', () => {
    expect(
      cutoutNeedsRework({
        cutoutStatus: 'success',
        digest: ` ${DIGEST.toUpperCase()} `,
        cutoutDigest: DIGEST,
      }),
    ).toBe(false);
  });
});
