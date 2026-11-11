import type { LoggerOptions } from 'pino';

/** Paths removed from every log line (pino redaction). SECURITY §6 / ARCHITECTURE §8. */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'req.body.password',
  'req.body.currentPassword',
  'req.body.newPassword',
  'password',
  '*.password',
  '*.secret',
  'secret',
];

export function loggerOptions(level: string): LoggerOptions {
  return {
    level,
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
  };
}
