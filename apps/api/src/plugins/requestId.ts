import type { FastifyInstance } from 'fastify';
import { uuidv7 } from '@tradex/domain';

/** Accept only short, log-safe ids from clients (prevents log injection). */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function genRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  return candidate !== undefined && SAFE_REQUEST_ID.test(candidate) ? candidate : uuidv7();
}

/** Echo `X-Request-Id` on every response, including errors and 404s. */
export function registerRequestId(app: FastifyInstance): void {
  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('X-Request-Id', request.id);
    done();
  });
}
