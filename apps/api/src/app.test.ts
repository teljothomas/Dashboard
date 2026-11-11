import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorEnvelope } from '@tradex/contracts';
import { isUuidV7 } from '@tradex/domain';
import { buildApp, BODY_LIMIT_BYTES } from './app.js';
import { AppError } from './errors.js';
import { SECURITY_HEADERS } from './plugins/securityHeaders.js';
import { testConfig } from './test-config.js';
import { createDummyDatabase, createFailingDatabase } from '../test/dummyDb.js';

let app: FastifyInstance | undefined;

function makeApp(): FastifyInstance {
  const instance = buildApp(testConfig, { db: createDummyDatabase() });
  instance.get('/_test/app-error', () => {
    throw new AppError('CONFLICT_VERSION', 'Version mismatch', { server: { version: 7 } });
  });
  instance.get('/_test/boom', () => {
    throw new Error('db password is hunter2');
  });
  instance.get('/_test/zod', () => {
    z.object({ amount: z.string() }).parse({ amount: 5 });
  });
  instance.post('/_test/echo', (request) => ({ body: request.body }));
  app = instance;
  return instance;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /health', () => {
  it('returns 200 {status:"ok"}', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('GET /health when the database is down', () => {
  it('returns 503 {status:"error"} with no details', async () => {
    const instance = buildApp(testConfig, { db: createFailingDatabase() });
    app = instance;
    const res = await instance.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'error' });
    expect(res.body).not.toContain('refused');
  });
});

describe('request id', () => {
  it('generates a UUID v7 and echoes it', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/health' });
    const id = res.headers['x-request-id'];
    expect(typeof id === 'string' && isUuidV7(id)).toBe(true);
  });

  it('accepts and echoes a safe client id', async () => {
    const res = await makeApp().inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'client-req_123' },
    });
    expect(res.headers['x-request-id']).toBe('client-req_123');
  });

  it('replaces an unsafe client id', async () => {
    const res = await makeApp().inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id with spaces' },
    });
    const id = res.headers['x-request-id'];
    expect(typeof id === 'string' && isUuidV7(id)).toBe(true);
  });
});

describe('error envelope', () => {
  it('unknown route returns a 404 envelope with the request id', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    const body = ErrorEnvelope.parse(res.json());
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
  });

  it('maps a thrown AppError to its code, status and details', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/_test/app-error' });
    expect(res.statusCode).toBe(409);
    const body = ErrorEnvelope.parse(res.json());
    expect(body.error.code).toBe('CONFLICT_VERSION');
    expect(body.error.message).toBe('Version mismatch');
    expect(body.error.details).toEqual({ server: { version: 7 } });
  });

  it('unknown error returns 500 INTERNAL with request id only, no internals', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/_test/boom' });
    expect(res.statusCode).toBe(500);
    const body = ErrorEnvelope.parse(res.json());
    expect(body.error.code).toBe('INTERNAL');
    expect(body.error.requestId).toBe(res.headers['x-request-id']);
    expect(body.error.details).toBeUndefined();
    expect(res.body).not.toContain('hunter2');
  });

  it('maps a ZodError to VALIDATION_FAILED with fields', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/_test/zod' });
    expect(res.statusCode).toBe(400);
    const body = ErrorEnvelope.parse(res.json());
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details).toHaveProperty('fields');
  });

  it('malformed JSON returns 400 VALIDATION_FAILED', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/_test/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"a":',
    });
    expect(res.statusCode).toBe(400);
    expect(ErrorEnvelope.parse(res.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('body over 1 MB returns 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/_test/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ pad: 'x'.repeat(BODY_LIMIT_BYTES) }),
    });
    expect(res.statusCode).toBe(413);
    expect(ErrorEnvelope.parse(res.json()).error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('unsupported content type returns 415 UNSUPPORTED_MEDIA', async () => {
    const res = await makeApp().inject({
      method: 'POST',
      url: '/_test/echo',
      headers: { 'content-type': 'application/xml' },
      payload: '<a/>',
    });
    expect(res.statusCode).toBe(415);
    expect(ErrorEnvelope.parse(res.json()).error.code).toBe('UNSUPPORTED_MEDIA');
  });
});

describe('security headers', () => {
  it('are present on success responses', async () => {
    const res = await makeApp().inject({ method: 'GET', url: '/health' });
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      expect(res.headers[name.toLowerCase()]).toBe(value);
    }
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['permissions-policy']).toContain('camera=(self)');
  });

  it('are present on 404 and 500 responses', async () => {
    const instance = makeApp();
    for (const url of ['/nope', '/_test/boom']) {
      const res = await instance.inject({ method: 'GET', url });
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
    }
  });
});
