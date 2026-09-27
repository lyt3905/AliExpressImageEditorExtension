import { describe, expect, it, vi } from 'vitest';
import { CutoutQueue } from '../../src/services/cutout-queue';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('CutoutQueue', () => {
  it('never exceeds the configured concurrency', async () => {
    const gates = new Map<string, ReturnType<typeof deferred>>();
    let active = 0;
    let maxActive = 0;

    const queue = new CutoutQueue({
      concurrency: 2,
      run: async (imageId) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        const gate = deferred();
        gates.set(imageId, gate);
        await gate.promise;
        active -= 1;
      },
    });

    for (const id of ['a', 'b', 'c', 'd']) queue.enqueue(id);
    await Promise.resolve();
    expect(gates.size).toBe(2);
    expect(queue.activeCount).toBe(2);
    expect(queue.waitingCount).toBe(2);

    gates.get('a')?.resolve();
    // Let the finally/pump microtask chain settle before checking the next batch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(gates.size).toBeGreaterThanOrEqual(3);

    // Drain everything: each pass releases the currently running batch and lets
    // the queue start (and record) the next one.
    for (let pass = 0; pass < 10; pass += 1) {
      gates.forEach((gate) => gate.resolve());
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await queue.whenIdle();
    expect(maxActive).toBe(2);
    expect(queue.activeCount).toBe(0);
  });

  it('ignores duplicate enqueues of the same image', async () => {
    const run = vi.fn(async () => undefined);
    const queue = new CutoutQueue({ concurrency: 2, run });

    expect(queue.enqueue('a')).toBe(true);
    expect(queue.enqueue('a')).toBe(false);
    expect(queue.enqueue('a')).toBe(false);
    await queue.whenIdle();
    expect(run).toHaveBeenCalledTimes(1);
    expect(queue.has('a')).toBe(true);
  });

  it('keeps running other tasks when one fails', async () => {
    const done: string[] = [];
    const failures: string[] = [];
    const queue = new CutoutQueue({
      concurrency: 2,
      run: async (imageId) => {
        if (imageId === 'b') throw new Error('boom');
        done.push(imageId);
      },
      onError: (imageId, error) => failures.push(`${imageId}:${(error as Error).message}`),
    });

    for (const id of ['a', 'b', 'c']) queue.enqueue(id);
    await queue.whenIdle();

    expect(done.sort()).toEqual(['a', 'c']);
    expect(failures).toEqual(['b:boom']);
  });

  it('re-runs a failed image on retry and not before', async () => {
    let attempts = 0;
    const queue = new CutoutQueue({
      concurrency: 1,
      run: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('first attempt fails');
      },
    });

    queue.enqueue('a');
    await queue.whenIdle();
    expect(attempts).toBe(1);
    expect(queue.enqueue('a')).toBe(false);

    expect(queue.retry('a')).toBe(true);
    await queue.whenIdle();
    expect(attempts).toBe(2);
  });

  it('reports progress and drops queued work on clear()', async () => {
    const seen: Array<[number, number]> = [];
    const queue = new CutoutQueue({
      concurrency: 1,
      run: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
      onProgress: (active, waiting) => seen.push([active, waiting]),
    });

    queue.enqueue('a');
    queue.enqueue('b');
    queue.clear();
    await queue.whenIdle();

    expect(queue.waitingCount).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    expect(queue.enqueue('c')).toBe(false);
  });

  it('rejects an invalid concurrency', () => {
    expect(() => new CutoutQueue({ concurrency: 0, run: async () => undefined })).toThrow();
  });
});
