import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Integration tests need the test DB: `docker compose -f deploy/compose.dev.yml up -d db`
// plus DATABASE_URL_TEST and DATABASE_URL_TEST_MIGRATE (see apps/api/.env.example).
// Values already in the environment win over apps/api/.env (CI sets them directly).
try {
  process.loadEnvFile(fileURLToPath(new URL('.env', import.meta.url)));
} catch {
  // no .env file: rely on the process environment
}
export default defineConfig({
  resolve: {
    alias: {
      '@tradex/contracts': src('../../packages/contracts/src/index.ts'),
      '@tradex/domain': src('../../packages/domain/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.integration.test.ts'],
    passWithNoTests: true,
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
