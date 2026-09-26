import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite()],
  test: {
    include: ['src/**/*.spec.ts'],
    fileParallelism: false,
    setupFiles: ['./vitest.guard.ts'],
    // Las pruebas de acciones sensibles se escribieron para el modo con reautenticación exigida;
    // el comportamiento por omisión (sin exigirla) tiene su propia prueba.
    env: {
      SESSION_SECRET: 'test-secret-test-secret-test-secret-1234',
      REQUIRE_RECENT_AUTH: 'true',
    },
  },
});
