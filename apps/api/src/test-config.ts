import type { AppConfig } from './config.js';

/** Config for tests only. Values are fake and never used outside unit tests. */
export const testConfig: AppConfig = {
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: 3000,
  DATABASE_URL: 'postgres://tradex_app:test@127.0.0.1:5432/tradex_test',
  LOG_LEVEL: 'silent',
  PUBLIC_ORIGIN: 'http://localhost:5173',
  ATTACHMENTS_DIR: './tmp-attachments',
  SESSION_SECRET: 'test-only-session-secret-0123456789abcdef',
};
