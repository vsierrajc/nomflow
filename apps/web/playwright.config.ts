import { defineConfig, devices } from '@playwright/test';

const TEST_DB =
  process.env.E2E_DATABASE_URL ?? 'postgresql://nomflow:nomflow@localhost:5432/nomflow_test';
const API_PORT = 4100;
const WEB_PORT = 3100;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run db:migrate -w @nomflow/api && node apps/api/dist/main.js',
      cwd: '../..',
      url: `http://localhost:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: String(API_PORT),
        DATABASE_URL: TEST_DB,
        SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-12345',
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_SECURE: 'false',
        SMTP_REQUIRE_TLS: 'false',
      },
    },
    {
      command: `npx next build && npx next start -p ${WEB_PORT}`,
      url: `http://localhost:${WEB_PORT}/login`,
      reuseExistingServer: false,
      timeout: 240_000,
      env: {
        API_URL: `http://localhost:${API_PORT}`,
        NEXT_DIST_DIR: '.next-e2e',
        NODE_ENV: 'production',
      },
    },
  ],
});
