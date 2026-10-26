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
  /** True once the grace period after load expired. */
  deadlineReached: boolean;
  /** True when a previous run (auto or manual) already produced something. */
  alreadyRan: boolean;
}

export type AutoComposeStep =
  /** Still gathering material; do nothing yet. */
  | { phase: 'wait'; reason: 'not-hydrated' | 'no-material-yet' | 'queue-busy' }
  /** Nothing to compose with; report once instead of waiting forever. */
  | { phase: 'skip'; reason: 'no-cutout' | 'already-ran' | 'canvas-not-empty' }
  | { phase: 'run'; reason: 'queue-settled' | 'deadline' };

export function autoComposeStep(input: AutoComposeInput): AutoComposeStep {
  const { hydrated, existingLayerCount, cutoutCount, active, waiting, deadlineReached, alreadyRan } = input;

  if (alreadyRan) return { phase: 'skip', reason: 'already-ran' };
  if (!hydrated) return { phase: 'wait', reason: 'not-hydrated' };

  // Checked before the material, so a restored canvas never even starts a run.
  if (existingLayerCount > 0) return { phase: 'skip', reason: 'canvas-not-empty' };

  if (cutoutCount === 0) {
    // An empty queue plus no deadline means the cut-outs have not started arriving
    // yet; past the deadline it means they failed, and silence would be confusing.
    return deadlineReached ? { phase: 'skip', reason: 'no-cutout' } : { phase: 'wait', reason: 'no-material-yet' };
  }

  if (active > 0 || waiting > 0) {
    // Partial material is worse than late material — but only up to the deadline.
    return deadlineReached ? { phase: 'run', reason: 'deadline' } : { phase: 'wait', reason: 'queue-busy' };
  }

  return { phase: 'run', reason: 'queue-settled' };
}
