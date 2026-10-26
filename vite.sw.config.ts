import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

/** Service worker build: single ESM file, no code splitting. */
export default defineConfig({
  root: resolve(rootDir, 'src'),
  // Same reason as vite.config.ts: `.env*` lives at the repo root, not under src/.
  envDir: rootDir,
  publicDir: false,
  base: './',
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'chrome114',
    sourcemap: false,
    rollupOptions: {
      input: resolve(rootDir, 'src/background/service-worker.ts'),
      output: {
        format: 'es',
        entryFileNames: 'service-worker.js',
        inlineDynamicImports: true,
      },
    },
  },
});
