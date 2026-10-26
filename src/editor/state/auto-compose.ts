/**
 * When the editor may compose a layout on its own.
 *
 * The rule the seller asked for is "open the editor and get a finished 主图, without
 * clicking anything". That sounds like "run it on load", but three things have to be
 * true before running, and getting any of them wrong is worse than not running:
 *
 * 1. **The material has to be there.** Cut-outs finish asynchronously, one at a time.
 *    Composing as soon as the FIRST one lands produces a layout with a missing
 *    package photo — the exact failure the fallback ladder exists to hide, but here
 *    it would be self-inflicted. So we wait for the queue to settle.
 * 2. **It must not wait forever.** A stuck cut-out must not mean "no 主图 today".
 *    After `deadlineReached` we compose with whatever survived.
 * 3. **It must not overwrite work.** The editor can reopen with a document restored
 *    from a previous session. Auto-composing over that would delete the seller's
 *    edits — and `APPLY_PLAN` would make it a single, easy-to-miss change.
 *
 * Kept pure (and therefore testable in Node) for the same reason as `auto-close.ts`:
 * the interesting part is the decision, not the React plumbing around it.
 */

export interface AutoComposeInput {
  /** Session + persisted document are loaded; nothing is known before that. */
  hydrated: boolean;
  /** Layers already on the canvas (restored from a previous session count here). */
  existingLayerCount: number;
  /** Cut-outs available right now. */
  cutoutCount: number;
  /** Cut-out queue: in-flight and queued items. */
  active: number;
  waiting: number;
  /**
   * Past the grace period: stop waiting for the queue to finish and compose with
   * whatever material exists.
   *
   * Deliberately NOT "give up" — a product with six photos legitimately takes longer
   * than the grace period to cut out, and the first version gave up at that point
   * when the count was still zero. The run then latched as "already ran", the panel
   * sat at 「素材就绪，准备排版…」 forever, and the only way to get an image was to
   * press the button by hand.
   */
  graceElapsed: boolean;
  /** Past the much longer give-up limit with still nothing to compose. */
  giveUpElapsed: boolean;
  /** True when a previous run (auto or manual) already produced something. */
  alreadyRan: boolean;
}

export type AutoComposeStep =
  /** Still gathering material; do nothing yet. */
  | { phase: 'wait'; reason: 'not-hydrated' | 'no-material-yet' | 'queue-busy' }
  /** Nothing to compose with, or not ours to touch; report once instead of waiting. */
  | { phase: 'skip'; reason: 'no-cutout' | 'already-ran' | 'canvas-not-empty' }
  | { phase: 'run'; reason: 'queue-settled' | 'grace' };

export function autoComposeStep(input: AutoComposeInput): AutoComposeStep {
  const {
    hydrated,
    existingLayerCount,
    cutoutCount,
    active,
    waiting,
    graceElapsed,
    giveUpElapsed,
    alreadyRan,
  } = input;

  if (alreadyRan) return { phase: 'skip', reason: 'already-ran' };
  if (!hydrated) return { phase: 'wait', reason: 'not-hydrated' };

  // Checked before the material, so a restored canvas never even starts a run.
  if (existingLayerCount > 0) return { phase: 'skip', reason: 'canvas-not-empty' };

  if (cutoutCount === 0) {
    // No material at all is a WAIT, not a deadline decision: cut-outs take 5–20 s
    // each and a slow batch can easily outlive the grace period. Only the much later
    // give-up limit turns this into "nothing to do".
    return giveUpElapsed ? { phase: 'skip', reason: 'no-cutout' } : { phase: 'wait', reason: 'no-material-yet' };
  }

  if (active > 0 || waiting > 0) {
    // Partial material is worse than late material — but only up to the grace period.
    // `giveUpElapsed` implies `graceElapsed` in practice (150 s > 30 s); treating it
    // that way here keeps the function honest if a caller ever passes only one.
    return graceElapsed || giveUpElapsed ? { phase: 'run', reason: 'grace' } : { phase: 'wait', reason: 'queue-busy' };
  }

  return { phase: 'run', reason: 'queue-settled' };
}
