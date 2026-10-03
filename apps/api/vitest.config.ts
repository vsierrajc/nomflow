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
      // Las pruebas inician sesión muchas más veces por archivo de lo que un cliente real haría en
      // 15 minutos (todas desde la misma IP del proceso); ip-rate-limit.e2e.spec.ts fija su propio
      // AUTH_RATE_LIMIT_MAX bajo para probar el límite en sí.
      AUTH_RATE_LIMIT_MAX: '1000',
      // Las pruebas de vacaciones usan fechas fijas de 2026; la prueba de la fecha mínima fija la suya.
      VACATION_ALLOW_PAST_START: 'true',
    },
  },
});
