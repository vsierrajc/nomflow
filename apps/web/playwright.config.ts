import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

/** Variables del almacén de objetos: del entorno (CI) o, en local, del .env del stack. */
function objectStoreEnv(): Record<string, string> {
  const fromFile: Record<string, string> = {};
  try {
    for (const line of readFileSync(join(__dirname, '..', '..', '.env'), 'utf8').split('\n')) {
      const m = /^(S3_[A-Z_]+|OBJECT_ENCRYPTION_KEY)=(.*)$/.exec(line.trim());
      if (m?.[1]) fromFile[m[1]] = (m[2] ?? '').replace(/^"|"$/g, '');
    }
  } catch {
    // sin .env: solo cuenta lo que venga del entorno
  }
  const pick = (k: string) => process.env[k] ?? fromFile[k];
  const out: Record<string, string> = {};
  for (const k of ['S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
    const v = pick(k);
    if (v) out[k] = v;
  }
  out.S3_BUCKET = pick('S3_TEST_BUCKET') || 'nomflow-test'; // nunca el bucket de desarrollo
  return out;
}

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
        HEALTH_MONITOR: 'off',
        SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-12345',
        SMTP_HOST: 'localhost',
        SMTP_PORT: '1025',
        SMTP_SECURE: 'false',
        SMTP_REQUIRE_TLS: 'false',
        TAX_CERT_INBOX_DIR: join(tmpdir(), 'nomflow-e2e-certificados'),
        ...objectStoreEnv(),
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
