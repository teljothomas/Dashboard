import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  CompanyVerifyRequest,
  HeartbeatRequest,
  ImportBatchRequest,
  LeaseAcquireRequest,
  LeaseReleaseRequest,
  CONNECTOR_STREAMS,
  ReconSnapshotRequest,
  RegisterRequest,
  type VersionResponse,
  type WatermarkDto,
} from '@tradex/contracts';
import { publicRoute } from '../../plugins/authorize.js';
import { rateLimitHook, SlidingWindowLimiter } from '../../plugins/rateLimit.js';
import { registerConnectorAuth, requireAgent } from './agentAuth.js';
import { verifyObserved } from './company.js';
import { applyImportBatch, applyReconSnapshot } from './importApply.js';
import { acquireLease, heartbeat, releaseLease } from './lease.js';
import { registerAgent } from './registration.js';

/** Registration attempts: 10 per 15 minutes per IP (a code is 79 bits, this only stops noise). */
const REGISTER_ATTEMPTS_PER_IP = 10;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

/**
 * Agent version policy served by `GET /version`. A constant until the agent installer exists
 * (WP-05.3); then it moves to configuration.
 */
export const VERSION_POLICY: VersionResponse = {
  minimumVersion: '0.1.0',
  latestVersion: '0.1.0',
  downloadNote: '',
};

const SIGNED = { config: { auth: publicRoute(), connectorSigned: true } } as const;

function actorOf(request: FastifyRequest): { requestId: string; ip: string } {
  return { requestId: request.id, ip: request.ip };
}

/**
 * Connector endpoints (INTERFACES section 5), registered under `/connector/v1`. Responses are the raw
 * bodies of the contract table (no `data` envelope); errors use the standard error envelope.
 * Authorization is the agent signature (`agentAuth.ts`), so every route declares `publicRoute()` for
 * the session layer; the route inventory test pins that list. Every mutating route runs the lease
 * check in the same transaction as its writes. Outbox endpoints are Phase 11.
 */
export function registerConnectorRoutes(app: FastifyInstance): void {
  const registerLimiter = new SlidingWindowLimiter(REGISTER_ATTEMPTS_PER_IP, FIFTEEN_MINUTES_MS);

  app.register(
    (api, _opts, done) => {
      registerConnectorAuth(api);

      api.post(
        '/register',
        {
          config: { auth: publicRoute() },
          preHandler: rateLimitHook(registerLimiter, (request) => request.ip),
        },
        async (request, reply) => {
          const body = RegisterRequest.parse(request.body);
          const registered = await registerAgent(app.db, body, actorOf(request));
          // A successful registration is not a failed guess: give the attempt back.
          registerLimiter.refund(request.ip);
          return reply.code(201).send(registered);
        },
      );

      api.post('/company/verify', SIGNED, async (request) => {
        const agent = requireAgent(request);
        const body = CompanyVerifyRequest.parse(request.body);
        return verifyObserved(app.db, agent.companyId, body.observed);
      });

      api.post('/lease/acquire', SIGNED, async (request) => {
        const agent = requireAgent(request);
        const body = LeaseAcquireRequest.parse(request.body);
        return acquireLease(app.db, agent, body.companyFingerprint);
      });

      api.post('/lease/release', SIGNED, async (request, reply) => {
        const agent = requireAgent(request);
        const body = LeaseReleaseRequest.parse(request.body);
        await releaseLease(app.db, agent, body.epoch);
        return reply.code(204).send();
      });

      api.post('/heartbeat', SIGNED, async (request) => {
        const agent = requireAgent(request);
        const body = HeartbeatRequest.parse(request.body);
        return heartbeat(app.db, agent, body);
      });

      api.get('/watermarks', SIGNED, async (request): Promise<WatermarkDto[]> => {
        const agent = requireAgent(request);
        const rows = await app.db
          .selectFrom('sync_watermark')
          .select(['stream', 'last_alter_id', 'last_full_recon_at'])
          .where('company_id', '=', agent.companyId)
          .execute();
        const byStream = new Map(rows.map((r) => [r.stream, r]));
        return CONNECTOR_STREAMS.map((stream) => {
          const row = byStream.get(stream);
          return {
            stream,
            lastAlterId: row ? Number(row.last_alter_id) : 0,
            lastFullReconAt: row?.last_full_recon_at ? row.last_full_recon_at.toISOString() : null,
          };
        });
      });

      api.post('/import-batches', SIGNED, async (request) => {
        const agent = requireAgent(request);
        const body = ImportBatchRequest.parse(request.body);
        return applyImportBatch(app.db, agent, body);
      });

      api.post('/recon-snapshots', SIGNED, async (request) => {
        const agent = requireAgent(request);
        const body = ReconSnapshotRequest.parse(request.body);
        return applyReconSnapshot(app.db, agent, body);
      });

      api.get('/version', SIGNED, (request) => {
        requireAgent(request);
        return VERSION_POLICY;
      });

      done();
    },
    { prefix: '/connector/v1' },
  );
}
