import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { loggerOptions } from './logger.js';

function capture(): { stream: Writable; lines: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return { stream, lines: () => chunks.join('') };
}

describe('logger redaction', () => {
  it('redacts cookie, authorization, password and secret fields', () => {
    const { stream, lines } = capture();
    const log = pino(loggerOptions('info'), stream);
    log.info({
      req: {
        headers: {
          cookie: 'sid=abc123',
          authorization: 'Bearer tok999',
          'x-csrf-token': 'csrf777',
        },
        body: { password: 'pw-secret-1', username: 'ravi' },
      },
      user: { password: 'pw-secret-2', secret: 'shh-3', name: 'visible' },
    });
    const out = lines();
    for (const leaked of ['abc123', 'tok999', 'csrf777', 'pw-secret-1', 'pw-secret-2', 'shh-3']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('[Redacted]');
    expect(out).toContain('ravi');
    expect(out).toContain('visible');
  });
});
