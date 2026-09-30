/**
 * When the editor is allowed to close itself after「回填到商品页」.
 *
 * The decision is a pure function of three numbers so the one rule that matters
 * can be tested without a browser: **a fill in flight holds the close off**.
 *
 * That rule is not cosmetic. Closing the editor tears down the message port that
 * keeps the service worker awake, and the fill — which runs in the worker, not
 * here — is in the middle of touching the product page. Measured on the real
 * page, a fill takes 5–25 s, so a countdown started at the click (10 s) used to
 * expire mid-fill nearly every time. The seller then saw the tab vanish while
 * the result only ever appeared on the toolbar badge.
 */

export interface AutoCloseInput {
  /**
   * Epoch ms at which the editor may close, or null when no close is pending.
   *
   * Armed from the CLICK, so the wait the user was promised ("10 秒") still
   * starts when they press the button; the fill only ever pushes the close
   * later, never earlier.
   */
  deadline: number | null;
  now: number;
  /** Whether the fill that armed this countdown has reported back. */
  fillSettled: boolean;
}

export type AutoCloseStep =
  /** No close pending (never armed, or cancelled). */
  | { phase: 'idle' }
  /** Deadline reached, but the fill is still running — wait for it. */
  | { phase: 'waiting-for-fill' }
  | { phase: 'countdown'; secondsLeft: number }
  | { phase: 'close' };

/**
 * One tick of the countdown.
 *
 * `fillSettled` is checked BEFORE the deadline: it must not be possible to reach
 * `close` while a fill is in flight, no matter how far past the deadline we are.
 */
export function autoCloseStep({ deadline, now, fillSettled }: AutoCloseInput): AutoCloseStep {
  if (deadline === null) return { phase: 'idle' };
  if (!fillSettled) return { phase: 'waiting-for-fill' };

  const left = deadline - now;
  if (left <= 0) return { phase: 'close' };
  return { phase: 'countdown', secondsLeft: Math.ceil(left / 1000) };
}
