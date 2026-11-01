/**
 * Session record construction.
 *
 * Only the pure builder is covered: `buildSessionRecord` touches no chrome API, and
 * it is the one place that decides which optional fields a session carries. The
 * 「Only Kits」 flag matters most here — it must survive a title that has no product
 * code, which is exactly when a kit listing needs the label.
 */

import { describe, expect, it } from 'vitest';
import { buildSessionRecord } from '../../src/background/session-manager';
import type { SessionImage } from '../../src/shared/types';

function sessionImage(id: string): SessionImage {
  return {
    id,
    index: 0,
    blobId: `blob-${id}`,
    url: `https://ae01.alicdn.com/${id}.jpg`,
    width: 800,
    height: 800,
    selected: true,
    cutoutStatus: 'idle',
  };
}

function build(extra: { onlyKits?: boolean | null; productCode?: string | null } = {}) {
  return buildSessionRecord({
    id: 'sess-test',
    sourceTabId: 42,
    sourceUrl: 'https://seller.aliexpress.com/publish',
    images: [sessionImage('a')],
    ...extra,
  });
}

describe('buildSessionRecord — onlyKits travels on its own', () => {
  it('keeps onlyKits even when the title carried no product code', () => {
    // The whole point: a kit title often has no `xxx-xxx` code, and the flag must
    // still reach the editor or no 「Only Kits」 layer is ever created.
    const record = build({ onlyKits: true });
    expect(record.onlyKits).toBe(true);
    expect(record).not.toHaveProperty('productCode');
  });

  it('records onlyKits alongside a product code when both are present', () => {
    const record = build({ onlyKits: true, productCode: 'MTS-TF-0001' });
    expect(record.onlyKits).toBe(true);
    expect(record.productCode).toBe('MTS-TF-0001');
  });

  it('omits the field entirely for false, undefined and null', () => {
    // Absent — not `false` — so a session written before this feature existed and a
    // non-kit session are indistinguishable downstream, as documented on the type.
    for (const onlyKits of [false, undefined, null]) {
      expect(build({ onlyKits }), String(onlyKits)).not.toHaveProperty('onlyKits');
    }
  });

  it('still fills the required metadata', () => {
    const record = build({ onlyKits: true });
    expect(record.id).toBe('sess-test');
    expect(record.sourceTabId).toBe(42);
    expect(record.sourceUrl).toBe('https://seller.aliexpress.com/publish');
    expect(record.imageIds).toEqual(['a']);
    expect(record.images).toHaveLength(1);
    expect(typeof record.createdAt).toBe('number');
  });
});
