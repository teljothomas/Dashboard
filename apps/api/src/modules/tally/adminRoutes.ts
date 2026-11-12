import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CreateCompanyRequest, LedgerListQuery, Uuid, VoucherListQuery } from '@tradex/contracts';
import { AppError } from '../../errors.js';
import { authorize } from '../../plugins/authorize.js';
import { actorOf, requireContext } from '../../plugins/requestContext.js';
import { createCompany, listCompanies } from './company.js';
import { getStatus, getVoucher, listLedgers, listVouchers } from './mirror.js';
import { issueRegistrationCode, listAgents, revokeAgent } from './registration.js';

const IdParams = z.object({ id: Uuid });
const GuidParams = z.object({ guid: z.string().min(1).max(128) });
const AgentListQuery = z.object({ companyId: Uuid.optional() });
const VoucherDetailQuery = z.object({ companyId: Uuid.optional() });

/**
 * Connector administration and the read-only mirror need an unlimited ALL grant: the scope resolver
 * names no owner and no division, so an OWN, DIVISION or division-limited grant answers 404 (fail
 * closed, same as the identity admin routes). Tally data belongs to the company, not to a division.
 */
const unlimited = () => ({});
const manageConnector = () => authorize('tally.connector.manage', { scope: unlimited });
const viewTallyData = () => authorize('tally.data.view', { scope: unlimited });
/** Status is connection health, readable by anyone with the dashboard (any scope). */
const viewDashboard = () => authorize('dashboard.view');

function noStore(reply: FastifyReply): void {
  void reply.header('Cache-Control', 'no-store');
}

function userActor(request: FastifyRequest) {
  const ctx = requireContext(request);
  return { ...actorOf(request, ctx), userId: ctx.userId };
}

/** `tally` module endpoints (INTERFACES section 2, tally rows), minus mappings and posting (Phase 11). */
export function registerTallyAdminRoutes(app: FastifyInstance): void {
  app.register(
    (api, _opts, done) => {
      api.get('/tally/companies', { config: { auth: manageConnector() } }, async () => ({
        data: await listCompanies(app.db),
      }));

      api.post(
        '/tally/companies',
        { config: { auth: manageConnector() } },
        async (request, reply) => {
          const body = CreateCompanyRequest.parse(request.body);
          const company = await createCompany(app.db, body, userActor(request));
          return reply.code(201).send({ data: company });
        },
      );

      api.post(
        '/tally/companies/:id/registration-code',
        { config: { auth: manageConnector() } },
        async (request, reply) => {
          const params = IdParams.safeParse(request.params);
          if (!params.success) throw new AppError('NOT_FOUND', 'Company not found');
          // The clear code is shown once: never cache it.
          noStore(reply);
          const code = await issueRegistrationCode(app.db, params.data.id, userActor(request));
          return reply.code(201).send({ data: code });
        },
      );

      api.get('/tally/agents', { config: { auth: manageConnector() } }, async (request) => {
        const query = AgentListQuery.parse(request.query);
        return { data: await listAgents(app.db, query) };
      });

      api.post(
        '/tally/agents/:id/revoke',
        { config: { auth: manageConnector() } },
        async (request) => {
          const params = IdParams.safeParse(request.params);
          if (!params.success) throw new AppError('NOT_FOUND', 'Agent not found');
          return { data: await revokeAgent(app.db, params.data.id, userActor(request)) };
        },
      );

      api.get('/tally/status', { config: { auth: viewDashboard() } }, async (_request, reply) => {
        noStore(reply);
        return { data: await getStatus(app.db) };
      });

      api.get('/tally/ledgers', { config: { auth: viewTallyData() } }, async (request) => {
        const query = LedgerListQuery.parse(request.query);
        const { items, nextCursor } = await listLedgers(app.db, query);
        return { data: items, ...(nextCursor ? { meta: { nextCursor } } : {}) };
      });

      api.get('/tally/vouchers', { config: { auth: viewTallyData() } }, async (request) => {
        const query = VoucherListQuery.parse(request.query);
        const { items, nextCursor } = await listVouchers(app.db, query);
        return { data: items, ...(nextCursor ? { meta: { nextCursor } } : {}) };
      });

      api.get('/tally/vouchers/:guid', { config: { auth: viewTallyData() } }, async (request) => {
        const params = GuidParams.safeParse(request.params);
        if (!params.success) throw new AppError('NOT_FOUND', 'Voucher not found');
        const query = VoucherDetailQuery.parse(request.query);
        return { data: await getVoucher(app.db, params.data.guid, query.companyId) };
      });

      done();
    },
    { prefix: '/api/v1' },
  );
}
