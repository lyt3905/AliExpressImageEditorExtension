/**
 * Opt-in instrument for "the canvas is hard to drag" reports.
 *
 * A drag repaints the whole Konva layer on every `mousemove`, so the only honest
 * way to know whether a change helped is to count those repaints and the one-off
 * costs around them. Chrome's profiler is not available to us from the repo
 * (`package.json` has no puppeteer/playwright), so the editor reports the numbers
 * itself, and only when asked: load the editor with `?debug=drag`.
 *
 * Deliberately tiny and side-effect free when disabled: `installDragDebug` is the
 * only thing that touches the stage.
 */

import type Konva from 'konva';

/** What the editor wants to report on each tick. */
export interface DragDebugStats {
  /** Image layers currently on the canvas. */
  imageLayers: number;
  /** Biggest picture source in pixels, as `1600x1600`. */
  largestSource: string;
  /** Copy-once costs: masks for the alpha hit area, and preview copies. */
  maskBuilds: number;
  maskMs: number;
  previewBuilds: number;
  previewMs: number;
  /** Preview scale, so frame counts can be read against what is drawn. */
  previewScale: number;
}

/** `?debug=drag` turns the instrument on. */
export function isDragDebugEnabled(search?: string): boolean {
  const query = search ?? (typeof window === 'undefined' ? '' : window.location.search);
  return new URLSearchParams(query).get('debug') === 'drag';
}

const TICK_MS = 2000;

/**
 * Patch nothing: Konva's `Layer` fires `draw` around `drawScene`, which is exactly
 * the per-frame work a drag repeats. Returns the cleanup function for a React
 * effect.
 */
export function installDragDebug(
  stage: Konva.Stage,
  readStats: () => DragDebugStats,
): () => void {
  const layer = stage.getLayers()[0];
  let draws = 0;
  const onDraw = (): void => {
    draws += 1;
  };
  layer?.on('draw.aiee-drag-debug', onDraw);

  let lastDraws = 0;
  let lastStats = readStats();
  let lastAt = performance.now();

  const timer = setInterval(() => {
    const at = performance.now();
    const elapsed = Math.max(1, at - lastAt);
    const stats = readStats();
    const fps = ((draws - lastDraws) * 1000) / elapsed;
    const maskBuilds = stats.maskBuilds - lastStats.maskBuilds;
    const previewBuilds = stats.previewBuilds - lastStats.previewBuilds;

    console.info(
      `[AIEE] 拖动诊断 ${Math.round(elapsed)}ms：场景重画 ${draws - lastDraws} 次（≈${fps.toFixed(1)} fps）` +
        ` · 图片层 ${stats.imageLayers} · 最大源 ${stats.largestSource}` +
        ` · 掩码构建 +${maskBuilds} 次/+${Math.round(stats.maskMs - lastStats.maskMs)}ms` +
        ` · 预览构建 +${previewBuilds} 次/+${Math.round(stats.previewMs - lastStats.previewMs)}ms` +
        ` · previewScale ${stats.previewScale.toFixed(3)}`,
    );

    lastDraws = draws;
    lastStats = stats;
    lastAt = at;
  }, TICK_MS);

  return () => {
    clearInterval(timer);
    layer?.off('.aiee-drag-debug');
  };
}
