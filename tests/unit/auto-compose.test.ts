import { describe, expect, it } from 'vitest';
import {
  autoComposeStep,
  countForeignLayers,
  type AutoComposeInput,
} from '../../src/editor/state/auto-compose';

function input(overrides: Partial<AutoComposeInput> = {}): AutoComposeInput {
  return {
    hydrated: true,
    existingLayerCount: 0,
    cutoutCount: 3,
    active: 0,
    waiting: 0,
    graceElapsed: false,
    giveUpElapsed: false,
    alreadyRan: false,
    ...overrides,
  };
}

describe('autoComposeStep — waiting for the right moment', () => {
  it('does nothing before the session is hydrated', () => {
    expect(autoComposeStep(input({ hydrated: false }))).toEqual({ phase: 'wait', reason: 'not-hydrated' });
  });

  it('waits for the first cut-out instead of composing with original photos', () => {
    expect(autoComposeStep(input({ cutoutCount: 0 }))).toEqual({ phase: 'wait', reason: 'no-material-yet' });
  });

  it('waits for the queue to settle, so the package photo is included', () => {
    // Composing on the first cut-out produces a layout with a missing package —
    // exactly the mistake the fallback ladder exists to hide, but self-inflicted.
    expect(autoComposeStep(input({ active: 2 }))).toEqual({ phase: 'wait', reason: 'queue-busy' });
    expect(autoComposeStep(input({ active: 0, waiting: 3 }))).toEqual({ phase: 'wait', reason: 'queue-busy' });
  });

  it('runs as soon as the queue is idle', () => {
    expect(autoComposeStep(input())).toEqual({ phase: 'run', reason: 'queue-settled' });
  });
});

describe('autoComposeStep — the two limits are not the same limit', () => {
  it('keeps waiting for the FIRST cut-out after the grace period', () => {
    // Regression: the grace period used to double as the give-up point. Six photos at
    // 5–20 s each outlive 30 s, so the run latched as "already ran" while the count was
    // still zero — the panel then showed 「素材就绪，准备排版…」 forever and the image
    // only appeared after a manual click.
    expect(autoComposeStep(input({ cutoutCount: 0, graceElapsed: true }))).toEqual({
      phase: 'wait',
      reason: 'no-material-yet',
    });
  });

  it('runs once material arrives, even long after the grace period', () => {
    expect(autoComposeStep(input({ graceElapsed: true, giveUpElapsed: false }))).toEqual({
      phase: 'run',
      reason: 'queue-settled',
    });
  });

  it('composes with partial material once the grace period is over', () => {
    expect(autoComposeStep(input({ active: 1, graceElapsed: true }))).toEqual({
      phase: 'run',
      reason: 'grace',
    });
  });

  it('gives up only at the much later limit, and only when there is still nothing', () => {
    expect(autoComposeStep(input({ cutoutCount: 0, graceElapsed: true, giveUpElapsed: true }))).toEqual({
      phase: 'skip',
      reason: 'no-cutout',
    });
    // With material present the give-up limit must not matter at all.
    expect(autoComposeStep(input({ giveUpElapsed: true }))).toEqual({
      phase: 'run',
      reason: 'queue-settled',
    });
    expect(autoComposeStep(input({ giveUpElapsed: true, active: 1 }))).toEqual({
      phase: 'run',
      reason: 'grace',
    });
  });
});

describe('autoComposeStep — never clobbering work', () => {
  it('leaves a restored canvas alone, even with material ready', () => {
    // APPLY_PLAN replaces the document in one history entry, so an automatic run
    // over a restored composition would delete the seller's edits quietly.
    expect(autoComposeStep(input({ existingLayerCount: 2 }))).toEqual({
      phase: 'skip',
      reason: 'canvas-not-empty',
    });
  });

  it('checks the canvas before the material, so an empty queue cannot still trigger a run', () => {
    expect(
      autoComposeStep(input({ existingLayerCount: 1, cutoutCount: 0, giveUpElapsed: true })),
    ).toEqual({ phase: 'skip', reason: 'canvas-not-empty' });
  });

  it('runs at most once per editor session', () => {
    expect(autoComposeStep(input({ alreadyRan: true }))).toEqual({ phase: 'skip', reason: 'already-ran' });
    // Even mid-queue and past both limits: one attempt is the contract.
    expect(
      autoComposeStep(input({ alreadyRan: true, active: 4, graceElapsed: true, giveUpElapsed: true })),
    ).toEqual({ phase: 'skip', reason: 'already-ran' });
  });
});

describe('countForeignLayers — the editor’s own layers are not the seller’s work', () => {
  const layers = [{ id: 'code-1' }, { id: 'logo-1' }, { id: 'mine-1' }, { id: 'mine-2' }];

  it('counts everything when nothing was auto-added', () => {
    expect(countForeignLayers(layers, new Set())).toBe(4);
  });

  it('ignores the auto-added code text and brand logo', () => {
    // The reported bug in one assertion: a canvas holding only the auto-added code
    // layer was counted as "existing work", so the run skipped with
    // 「已恢复上次的画布，未自动覆盖」 on every product whose title carried a code.
    expect(countForeignLayers(layers, new Set(['code-1', 'logo-1']))).toBe(2);
  });

  it('treats a canvas with only auto layers as empty', () => {
    expect(countForeignLayers([{ id: 'code-1' }], new Set(['code-1']))).toBe(0);
    // Which is what makes the step run rather than skip:
    expect(autoComposeStep(input({ existingLayerCount: 0 }))).toEqual({
      phase: 'run',
      reason: 'queue-settled',
    });
  });

  it('tolerates ids in the set that are no longer on the canvas', () => {
    // Deleted layers keep their id in the set; they must not skew the count.
    expect(countForeignLayers(layers, new Set(['code-1', 'deleted-layer']))).toBe(3);
  });

  it('is zero for an empty canvas', () => {
    expect(countForeignLayers([], new Set(['code-1']))).toBe(0);
  });
});
