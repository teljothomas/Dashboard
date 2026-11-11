import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
  PUBLIC_ORIGIN: 'https://erp.example.test',
  ATTACHMENTS_DIR: '/var/lib/tradex/attachments',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(valid);
    expect(c.NODE_ENV).toBe('development');
    expect(c.PORT).toBe(3000);
    expect(c.HOST).toBe('127.0.0.1');
    expect(c.LOG_LEVEL).toBe('info');
  });

  it('coerces PORT from a string', () => {
    expect(loadConfig({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('fails fast on missing required variables', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('rejects a short SESSION_SECRET without echoing its value', () => {
    const secret = 'short-secret-value';
    let message = '';
    try {
      loadConfig({ ...valid, SESSION_SECRET: secret });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = (err as Error).message;
    }
    expect(message).toContain('SESSION_SECRET');
    expect(message).not.toContain(secret);
  });

  it('rejects an invalid NODE_ENV, PORT and LOG_LEVEL', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'staging' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, PORT: '70000' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...valid, LOG_LEVEL: 'loud' })).toThrow(ConfigError);
  });
});
