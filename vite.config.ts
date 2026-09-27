import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

/** UI build: editor + options pages, plus the static manifest from public/. */
export default defineConfig({
  root: resolve(rootDir, 'src'),
  publicDir: resolve(rootDir, 'public'),
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(rootDir, 'dist'),
    emptyOutDir: true,
    target: 'chrome114',
    sourcemap: false,
    rollupOptions: {
      input: {
        editor: resolve(rootDir, 'src/editor/index.html'),
        options: resolve(rootDir, 'src/options/index.html'),
      },
    },
  },
});
