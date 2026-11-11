import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Integration tests need the test DB: `docker compose -f deploy/compose.dev.yml up -d db`
// and DATABASE_URL_TEST (see apps/api/.env.example). The suite is empty until WP-03.1.
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
