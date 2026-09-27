import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

/** Content script build: content scripts cannot use ESM, so emit a single IIFE. */
export default defineConfig({
  root: resolve(rootDir, 'src'),
  publicDir: false,
  base: './',
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: false,
    copyPublicDir: false,
    target: 'chrome114',
    sourcemap: false,
    rollupOptions: {
      input: resolve(rootDir, 'src/content/content-script.ts'),
      output: {
        format: 'iife',
        entryFileNames: 'content-script.js',
        inlineDynamicImports: true,
      },
    },
  },
});
