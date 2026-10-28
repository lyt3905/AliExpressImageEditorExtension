import { describe, expect, it, vi } from 'vitest';
import { claimSilentSyncAttempt } from '../../src/services/brand-catalog/silent-sync';

/**
 * The latch is tiny but the frequency it enforces is the point: a failed sync
 * (GitHub unreachable) leaves the TTL untouched, so without this every editor
 * open would pay a 15s timeout. One attempt per tab.
 *
 * The flag lives in module scope, so `vi.resetModules()` + a fresh dynamic import
 * is what "a new tab" looks like here.
 */
describe('claimSilentSyncAttempt', () => {
  it('grants the first attempt and refuses the second', () => {
    expect(claimSilentSyncAttempt()).toBe(true);
    expect(claimSilentSyncAttempt()).toBe(false);
  });

  it('starts fresh in a new module instance (a new tab)', async () => {
    vi.resetModules();
    const fresh = await import('../../src/services/brand-catalog/silent-sync');
    expect(fresh.claimSilentSyncAttempt()).toBe(true);
    expect(fresh.claimSilentSyncAttempt()).toBe(false);
  });
});
