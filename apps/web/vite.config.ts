import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const fromRoot = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

const apiPort = process.env.API_PORT ?? '3000';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Workspace packages are consumed from source: no build step needed for dev, test or bundling.
    alias: {
      '@tradex/contracts': fromRoot('../../packages/contracts/src/index.ts'),
      '@tradex/domain': fromRoot('../../packages/domain/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: false,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
