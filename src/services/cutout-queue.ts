/**
 * Minimal cutout task queue.
 *
 * Guarantees:
 *   - at most `concurrency` tasks run at the same time;
 *   - the same imageId is never dispatched twice before it is retried;
 *   - one failing task never stops the others.
 */

export type CutoutTaskRunner = (imageId: string) => Promise<void>;

export interface CutoutQueueOptions {
  concurrency: number;
  run: CutoutTaskRunner;
  onError?: (imageId: string, error: unknown) => void;
  onProgress?: (activeCount: number, waitingCount: number) => void;
}

export class CutoutQueue {
  private readonly concurrency: number;
  private readonly run: CutoutTaskRunner;
  private readonly onError?: (imageId: string, error: unknown) => void;
  private readonly onProgress?: (activeCount: number, waitingCount: number) => void;

  private waiting: string[] = [];
  private readonly active = new Set<string>();
  /** Every id ever accepted, so re-renders cannot enqueue the same image twice. */
  private readonly dispatched = new Set<string>();

  private closed = false;
  private readonly idleResolvers: Array<() => void> = [];

  constructor(options: CutoutQueueOptions) {
    if (!Number.isFinite(options.concurrency) || options.concurrency < 1) {
      throw new Error('concurrency 必须是 >= 1 的整数');
    }
    this.concurrency = Math.floor(options.concurrency);
    this.run = options.run;
    if (options.onError) this.onError = options.onError;
    if (options.onProgress) this.onProgress = options.onProgress;
  }

  get activeCount(): number {
    return this.active.size;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  /** True when the id is queued, running, or has already been dispatched. */
  has(imageId: string): boolean {
    return this.dispatched.has(imageId) || this.active.has(imageId);
  }

  /**
   * Accept a task. Returns false when the id is already known, which is what
   * makes React re-renders and `queued/uploading/processing` states safe.
   */
  enqueue(imageId: string): boolean {
    if (this.closed) return false;
    if (this.dispatched.has(imageId) || this.active.has(imageId)) return false;
    this.dispatched.add(imageId);
    this.waiting.push(imageId);
    this.pump();
    return true;
  }

  /** Forget the id and enqueue it again (the "重试" button). */
  retry(imageId: string): boolean {
    this.dispatched.delete(imageId);
    const index = this.waiting.indexOf(imageId);
    if (index >= 0) this.waiting.splice(index, 1);
    if (this.active.has(imageId)) return false;
    return this.enqueue(imageId);
  }

  /** Stop accepting work and drop everything still waiting. */
  clear(): void {
    this.closed = true;
    this.waiting = [];
    this.notifyProgress();
    this.resolveIdleIfNeeded();
  }

  /** Resolve once nothing is running and nothing is waiting. */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  private isIdle(): boolean {
    return this.active.size === 0 && this.waiting.length === 0;
  }

  private resolveIdleIfNeeded(): void {
    if (!this.isIdle()) return;
    while (this.idleResolvers.length) {
      const resolve = this.idleResolvers.shift();
      resolve?.();
    }
  }

  private notifyProgress(): void {
    this.onProgress?.(this.active.size, this.waiting.length);
  }

  private pump(): void {
    while (!this.closed && this.active.size < this.concurrency && this.waiting.length > 0) {
      const imageId = this.waiting.shift();
      if (imageId === undefined) break;
      this.active.add(imageId);
      this.notifyProgress();

      this.run(imageId)
        .catch((error: unknown) => {
          this.onError?.(imageId, error);
        })
        .finally(() => {
          this.active.delete(imageId);
          this.notifyProgress();
          this.pump();
          this.resolveIdleIfNeeded();
        });
    }
    this.notifyProgress();
    this.resolveIdleIfNeeded();
  }
}
