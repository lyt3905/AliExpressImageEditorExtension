import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

/** UI build: editor + options pages, plus the static manifest from public/. */
export default defineConfig({
  root: resolve(rootDir, 'src'),
  /*
    `.env*` files live at the REPO ROOT, next to package.json — `.env.example`
    documents them there and `.gitignore` excludes `.env.local` there. Vite defaults
    `envDir` to `root`, which is `src/`, so without this line a root `.env.local` is
    silently ignored and `import.meta.env.VITE_*` stays undefined: the build succeeds
    and the value is simply missing. That is exactly how the vision API key failed to
    reach the bundle the first time.
  */
  envDir: rootDir,
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
