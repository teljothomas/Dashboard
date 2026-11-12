import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { AnyUuid, CONNECTOR_HEADERS, CONNECTOR_TIMESTAMP_WINDOW_SECONDS } from '@tradex/contracts';
import { AppError } from '../../errors.js';
import type { AuthenticatedAgent } from './lease.js';
import { canonicalString, sha256Hex, verifySignature } from './signature.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set only after the signature and nonce of a signed connector call were verified. */
    agent: AuthenticatedAgent | null;
    /** Raw body bytes of a connector call (the signature covers them). */
    rawBody: Buffer | null;
  }
  interface FastifyContextConfig {
    /** Connector routes other than `register` must set this: the call needs a valid agent signature. */
    connectorSigned?: boolean;
  }
}

/** Largest connector body: a reconciliation snapshot of 50 000 guids is about 4 MB. */
export const CONNECTOR_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const NONCE_RETENTION_MINUTES = 10;
const NONCE_PURGE_EVERY_MS = 60 * 1000;
const TIMESTAMP_PATTERN = /^\d{1,12}$/;
const MAX_SIGNATURE_LENGTH = 200;
const REGISTER_PATH = '/connector/v1/register';

interface PendingAgent extends AuthenticatedAgent {
  publicKey: string;
  timestamp: string;
  nonce: string;
  signature: string;
}

const pending = new WeakMap<FastifyRequest, PendingAgent>();

/**
 * One generic failure for every authentication problem (unknown agent, revoked, skewed clock, bad
 * signature, replay): the response must not tell an attacker which check failed. The reason goes to
 * the log only.
 */
function reject(request: FastifyRequest, reason: string): never {
  request.log.warn({ reason }, 'connector authentication failed');
  throw new AppError('UNAUTHENTICATED', 'Request authentication failed.');
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Signed-request authentication for the `/connector/v1` scope (SECURITY section 1, INTERFACES
 * section 5). Call it inside the encapsulated connector plugin, before registering any route.
 *
 * - The JSON body is captured raw (the signature covers the bytes) and parsed only after the caller is
 *   authenticated, so an unauthenticated caller learns nothing from a parse error.
 * - `onRequest`: agent exists and is ACTIVE, headers well formed, timestamp within the window.
 * - `preValidation`: signature over METHOD, raw URL, timestamp, nonce and body hash; then the nonce is
 *   recorded (unique per agent, so a replay finds it) and `request.agent` is set. Nothing is inserted
 *   for an unsigned or badly signed request.
 * - A route under the scope must either be `register` or declare `config.connectorSigned`; anything
 *   else fails at registration time.
 */
export function registerConnectorAuth(app: FastifyInstance): void {
  app.decorateRequest('agent', null);
  app.decorateRequest('rawBody', null);
  let lastNoncePurge = 0;

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: CONNECTOR_BODY_LIMIT_BYTES },
    (request, body, done) => {
      request.rawBody = body as Buffer;
      done(null, undefined);
    },
  );

  app.addHook('onRoute', (route) => {
    const signed = route.config?.connectorSigned === true;
    if (!signed && route.url !== REGISTER_PATH) {
      throw new Error(
        `Connector route ${String(route.method)} ${route.url} must set config.connectorSigned (only register is unsigned)`,
      );
    }
  });

  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config.connectorSigned !== true) return;
    const agentId = AnyUuid.safeParse(header(request, CONNECTOR_HEADERS.agentId));
    const nonce = AnyUuid.safeParse(header(request, CONNECTOR_HEADERS.nonce));
    const timestamp = header(request, CONNECTOR_HEADERS.timestamp);
    const signature = header(request, CONNECTOR_HEADERS.signature);
    if (
      !agentId.success ||
      !nonce.success ||
      timestamp === undefined ||
      !TIMESTAMP_PATTERN.test(timestamp) ||
      signature === undefined ||
      signature.length === 0 ||
      signature.length > MAX_SIGNATURE_LENGTH
    ) {
      reject(request, 'missing or malformed signature headers');
    }
    const skew = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (skew > CONNECTOR_TIMESTAMP_WINDOW_SECONDS) reject(request, 'timestamp outside window');

    const agent = await app.db
      .selectFrom('connector_agent')
      .select(['id', 'company_id', 'machine_name', 'public_key', 'status'])
      .where('id', '=', agentId.data)
      .executeTakeFirst();
    if (!agent || agent.status !== 'ACTIVE') reject(request, 'unknown or revoked agent');
    pending.set(request, {
      id: agent.id,
      companyId: agent.company_id,
      machineName: agent.machine_name,
      publicKey: agent.public_key,
      timestamp,
      nonce: nonce.data,
      signature,
    });
  });

  app.addHook('preValidation', async (request) => {
    const rawBody = request.rawBody ?? Buffer.alloc(0);
    const signed = request.routeOptions.config.connectorSigned === true;
    if (signed) {
      const candidate = pending.get(request);
      if (!candidate) reject(request, 'no pending agent');
      const canonical = canonicalString({
        method: request.method,
        path: request.raw.url ?? request.url,
        timestamp: candidate.timestamp,
        nonce: candidate.nonce,
        bodySha256: sha256Hex(rawBody),
      });
      if (!verifySignature(candidate.publicKey, canonical, candidate.signature)) {
        reject(request, 'bad signature');
      }
      const fresh = await app.db
        .insertInto('connector_nonce')
        .values({ agent_id: candidate.id, nonce: candidate.nonce })
        .onConflict((oc) => oc.columns(['agent_id', 'nonce']).doNothing())
        .returning('nonce')
        .executeTakeFirst();
      if (!fresh) reject(request, 'replayed nonce');
      request.agent = {
        id: candidate.id,
        companyId: candidate.companyId,
        machineName: candidate.machineName,
      };
      const nowMs = Date.now();
      if (nowMs - lastNoncePurge > NONCE_PURGE_EVERY_MS) {
        lastNoncePurge = nowMs;
        await app.db
          .deleteFrom('connector_nonce')
          .where('at', '<', sql<Date>`now() - make_interval(mins => ${NONCE_RETENTION_MINUTES})`)
          .execute()
          .catch(() => undefined);
      }
    }
    if (rawBody.length > 0) {
      try {
        request.body = JSON.parse(rawBody.toString('utf8')) as unknown;
      } catch {
        throw new AppError('VALIDATION_FAILED', 'Request body is not valid JSON');
      }
    }
  });
}

/** The authenticated agent of a signed route. */
export function requireAgent(request: FastifyRequest): AuthenticatedAgent {
  if (!request.agent) throw new AppError('UNAUTHENTICATED', 'Request authentication failed.');
  return request.agent;
}
