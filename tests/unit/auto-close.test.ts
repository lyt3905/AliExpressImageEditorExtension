import { describe, expect, it } from 'vitest';
import { autoCloseStep } from '../../src/editor/state/auto-close';

/**
 * The one rule worth pinning down is that a fill in flight holds the close off.
 * It was got wrong once: the countdown ran from the click, expired at 10 s, and
 * took the tab down while a 5–25 s fill was still touching the product page.
 */
const T0 = 1_700_000_000_000;
const DEADLINE = T0 + 10_000;

describe('autoCloseStep', () => {
  it('is idle when no close is pending', () => {
    expect(autoCloseStep({ deadline: null, now: T0, fillSettled: true })).toEqual({ phase: 'idle' });
  });

  it('counts down while the deadline is in the future', () => {
    expect(autoCloseStep({ deadline: DEADLINE, now: T0, fillSettled: true })).toEqual({
      phase: 'countdown',
      secondsLeft: 10,
    });
    expect(autoCloseStep({ deadline: DEADLINE, now: T0 + 9_000, fillSettled: true })).toEqual({
      phase: 'countdown',
      secondsLeft: 1,
    });
  });

  it('rounds a part-second up, so the label never reads 0 while still counting', () => {
    expect(autoCloseStep({ deadline: DEADLINE, now: T0 + 9_001, fillSettled: true })).toEqual({
      phase: 'countdown',
      secondsLeft: 1,
    });
  });

  it('closes on the deadline itself', () => {
    expect(autoCloseStep({ deadline: DEADLINE, now: DEADLINE, fillSettled: true })).toEqual({
      phase: 'close',
    });
  });

  it('★ holds the close while the fill is still running, however late it is', () => {
    expect(autoCloseStep({ deadline: DEADLINE, now: DEADLINE, fillSettled: false })).toEqual({
      phase: 'waiting-for-fill',
    });
    // 25 s fills do happen; "the deadline passed" must never be enough on its own.
    expect(autoCloseStep({ deadline: DEADLINE, now: DEADLINE + 60_000, fillSettled: false })).toEqual({
      phase: 'waiting-for-fill',
    });
  });

  it('reports the wait even before the deadline, rather than promising a number', () => {
    expect(autoCloseStep({ deadline: DEADLINE, now: T0 + 1_000, fillSettled: false })).toEqual({
      phase: 'waiting-for-fill',
    });
  });

  it('keeps counting down normally when the fill settles early', () => {
    // A fast fill must not cut the promised wait short.
    expect(autoCloseStep({ deadline: DEADLINE, now: T0 + 3_000, fillSettled: true })).toEqual({
      phase: 'countdown',
      secondsLeft: 7,
    });
  });

  it('stays idle when the countdown was cancelled, even with a fill in flight', () => {
    // 取消 clears the deadline; an unsettled fill must not be able to resurrect
    // a close on its own.
    expect(autoCloseStep({ deadline: null, now: DEADLINE + 60_000, fillSettled: false })).toEqual({
      phase: 'idle',
    });
  });
});
