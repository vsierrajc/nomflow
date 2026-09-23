import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ['src/**/*.spec.ts'],
    fileParallelism: false,
    env: { SESSION_SECRET: 'test-secret-test-secret-test-secret-1234' },
  },
});
