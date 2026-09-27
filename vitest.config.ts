import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    restoreMocks: true,
    // Files run sequentially: the suite is small, and concurrent workers racing to
    // write Vitest's on-disk SSR module cache can fail with EPERM on Windows.
    fileParallelism: false,
  },
});
