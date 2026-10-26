import { describe, expect, it } from 'vitest';
import { autoComposeStep, type AutoComposeInput } from '../../src/editor/state/auto-compose';

function input(overrides: Partial<AutoComposeInput> = {}): AutoComposeInput {
  return {
    hydrated: true,
    existingLayerCount: 0,
    cutoutCount: 3,
    active: 0,
    waiting: 0,
    deadlineReached: false,
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

describe('autoComposeStep — never waiting forever', () => {
  it('composes with whatever survived once the grace period is over', () => {
    expect(autoComposeStep(input({ active: 1, deadlineReached: true }))).toEqual({
      phase: 'run',
      reason: 'deadline',
    });
  });

  it('gives up when nothing was cut out in time, instead of waiting silently', () => {
    expect(autoComposeStep(input({ cutoutCount: 0, deadlineReached: true }))).toEqual({
      phase: 'skip',
      reason: 'no-cutout',
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
    expect(autoComposeStep(input({ existingLayerCount: 1, cutoutCount: 0, deadlineReached: true }))).toEqual({
      phase: 'skip',
      reason: 'canvas-not-empty',
    });
  });

  it('runs at most once per editor session', () => {
    expect(autoComposeStep(input({ alreadyRan: true }))).toEqual({ phase: 'skip', reason: 'already-ran' });
    // Even mid-queue and past the deadline: one attempt is the contract.
    expect(
      autoComposeStep(input({ alreadyRan: true, active: 4, deadlineReached: true })),
    ).toEqual({ phase: 'skip', reason: 'already-ran' });
  });
});
