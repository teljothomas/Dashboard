import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@tradex/contracts': src('../../packages/contracts/src/index.ts'),
      '@tradex/domain': src('../../packages/domain/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
