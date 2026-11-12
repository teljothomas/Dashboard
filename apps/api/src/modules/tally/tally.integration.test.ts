import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  ConnectorAgentDto,
  RegistrationCodeDto,
  SessionInfo,
  TallyCompanyDto,
  TallyLedgerDto,
  TallyStatusDto,
  TallyVoucherDetailDto,
  TallyVoucherDto,
} from '@tradex/contracts';
import { uuidv7 } from '@tradex/domain';
import { MIGRATIONS_DIR, resetDatabase, testDbUrls, truncateAll } from '../../../test/db.js';
import { buildApp } from '../../app.js';
import { createDatabase, type Database } from '../../db/index.js';
import { runMigrations } from '../../db/migrate.js';
import { testConfig } from '../../test-config.js';
import { publicRoute } from '../../plugins/authorize.js';
import { createOwner, hashPassword } from '../identity/index.js';
import { registerConnectorAuth } from './agentAuth.js';
import { onVouchersImported, type VouchersImportedEvent } from './hooks.js';
import { canonicalString, sha256Hex } from './signature.js';

/**
 * WP-05.2: connector signature (TS-S05), lease and epoch (TS-T11), import apply (batch idempotency,
 * watermarks, deletion snapshots, TS-A08 / TS-A09), mirror schema, admin endpoints. Real database,
 * real production wiring; the "agent" is the test code signing requests with its own key.
 */

const urls = testDbUrls();
const PASSWORD = 'tractor-lantern-meadow-42';
const API = '/api/v1';
const C = '/connector/v1';
const GENERIC_AUTH_MESSAGE = 'Request authentication failed.';

let db: Database;
let owner: pg.Pool;
let app: FastifyInstance | undefined;
let passwordHash: string;
let admin: Session;
let company: TallyCompanyDto;

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  db = createDatabase(urls.app);
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
  passwordHash = await hashPassword(PASSWORD);
});

beforeEach(async () => {
  await truncateAll(urls);
  await createOwner(db, { username: 'asha.owner', displayName: 'Asha', password: PASSWORD });
  admin = await login('asha.owner');
  company = await createCompanyViaApi();
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

function instance(): FastifyInstance {
  app ??= buildApp({ ...testConfig, DATABASE_URL: urls.app }, { db });
  return app;
}

// ---------------------------------------------------------------------------
// helpers: browser session
// ---------------------------------------------------------------------------

interface Session {
  cookie: string;
  csrf: string;
  deviceId: string;
}

async function login(username: string): Promise<Session> {
  const deviceId = uuidv7();
  const res = await instance().inject({
    method: 'POST',
    url: `${API}/auth/login`,
    payload: { username, password: PASSWORD, deviceId },
  });
  expect(res.statusCode, `login ${username}`).toBe(200);
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? (raw[0] ?? '') : (raw ?? '');
  const info = res.json<{ data: SessionInfo }>().data;
  return { cookie: header.split(';')[0] ?? '', csrf: info.csrfToken, deviceId };
}

function call(
  session: Session,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return instance().inject({
    method,
    url: `${API}${url}`,
    headers: {
      cookie: session.cookie,
      'x-device-id': session.deviceId,
      ...(method === 'GET' ? {} : { 'x-csrf-token': session.csrf }),
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

const data = <T>(res: LightMyRequestResponse): T => res.json<{ data: T }>().data;
const errorOf = (res: LightMyRequestResponse) =>
  res.json<{ error: { code: string; message: string; details?: Record<string, unknown> } }>().error;

async function mkUser(username: string, roleCode: string): Promise<void> {
  const id = uuidv7();
  await owner.query(
    `INSERT INTO app_user (id, username, display_name, password_hash, status, must_change_password)
     VALUES ($1, $2, $2, $3, 'ACTIVE', false)`,
    [id, username, passwordHash],
  );
  await owner.query(
    `INSERT INTO user_role (id, user_id, role_id) SELECT $1, $2, id FROM role WHERE code = $3`,
    [uuidv7(), id, roleCode],
  );
}

async function createCompanyViaApi(over: Record<string, unknown> = {}): Promise<TallyCompanyDto> {
  const res = await call(admin, 'POST', '/tally/companies', {
    displayName: 'Acme Meats (test)',
    tallyName: 'Acme Meats Pvt Ltd',
    booksFrom: '2025-04-01',
    isTest: true,
    ...over,
  });
  expect(res.statusCode, res.body).toBe(201);
  return data<TallyCompanyDto>(res);
}

// ---------------------------------------------------------------------------
// helpers: the agent
// ---------------------------------------------------------------------------

interface Agent {
  id: string;
  companyId: string;
  privateKey: KeyObject;
  publicPem: string;
}

function newKeys(): { privateKey: KeyObject; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { privateKey, publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

async function issueCode(companyId = company.id): Promise<string> {
  const res = await call(admin, 'POST', `/tally/companies/${companyId}/registration-code`);
  expect(res.statusCode, res.body).toBe(201);
  return data<RegistrationCodeDto>(res).code;
}

function rawRegister(
  code: string,
  publicKeyPem: string,
  machineName = 'TALLY-PC',
): Promise<LightMyRequestResponse> {
  return instance().inject({
    method: 'POST',
    url: `${C}/register`,
    payload: {
      registrationCode: code,
      machineName,
      machineFingerprint: 'machine-fingerprint-0001',
      publicKeyPem,
      agentVersion: '0.1.0',
    },
  });
}

async function registerAgent(companyId = company.id, machineName = 'TALLY-PC'): Promise<Agent> {
  const keys = newKeys();
  const res = await rawRegister(await issueCode(companyId), keys.publicPem, machineName);
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json<{ agentId: string; companyId: string }>();
  return { id: body.agentId, companyId: body.companyId, ...keys };
}

interface SignOptions {
  agentId?: string;
  key?: KeyObject;
  timestamp?: number;
  nonce?: string;
  /** Sign this body but send another (tamper test). */
  signedBody?: string;
  signedPath?: string;
  omit?: string[];
}

function signedCall(
  agent: Agent,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  options: SignOptions = {},
): Promise<LightMyRequestResponse> {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? randomUUID();
  const canonical = canonicalString({
    method,
    path: options.signedPath ?? path,
    timestamp,
    nonce,
    bodySha256: sha256Hex(options.signedBody ?? payload),
  });
  const signature = sign('sha256', Buffer.from(canonical), {
    key: options.key ?? agent.privateKey,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64');
  const headers: Record<string, string> = {
    'x-agent-id': options.agentId ?? agent.id,
    'x-timestamp': timestamp,
    'x-nonce': nonce,
    'x-signature': signature,
    ...(payload === '' ? {} : { 'content-type': 'application/json' }),
  };
  for (const name of options.omit ?? []) delete headers[name];
  return instance().inject({
    method,
    url: path,
    headers,
    ...(payload === '' ? {} : { payload }),
  });
}

async function verifyCompany(agent: Agent): Promise<string> {
  const res = await signedCall(agent, 'POST', `${C}/company/verify`, {
    observed: { tallyName: 'ACME MEATS PVT LTD', booksFrom: '2025-04-01' },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<{ match: boolean; fingerprint: string }>();
  expect(body.match).toBe(true);
  return body.fingerprint;
}

async function acquire(agent: Agent): Promise<LightMyRequestResponse> {
  return signedCall(agent, 'POST', `${C}/lease/acquire`, {
    companyFingerprint: await verifyCompany(agent),
  });
}

async function lease(agent: Agent): Promise<number> {
  const res = await acquire(agent);
  expect(res.statusCode, res.body).toBe(200);
  return res.json<{ epoch: number }>().epoch;
}

async function expireLease(): Promise<void> {
  await owner.query(`UPDATE connector_lease SET expires_at = now() - interval '1 second'`);
}

async function importBatch(
  agent: Agent,
  epoch: number,
  stream: 'MASTERS' | 'VOUCHERS' | 'BALANCES',
  records: unknown[],
  extra: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return signedCall(agent, 'POST', `${C}/import-batches`, {
    batchId: randomUUID(),
    epoch,
    stream,
    fromAlterId: null,
    toAlterId: null,
    records,
    ...extra,
  });
}

const count = async (table: string): Promise<number> =>
  (await owner.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.n ?? -1;

function voucher(guid: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    guid,
    voucherTypeName: 'Receipt',
    baseType: 'RECEIPT',
    voucherNumber: '1',
    voucherDate: '2025-04-01',
    partyLedgerName: 'Customer A',
    amount: '1000.00',
    ledgerLines: [
      { ledgerName: 'Customer A', amount: '1000.00', isParty: true },
      { ledgerName: 'Bank Account', amount: '-1000.00' },
    ],
    ...over,
  };
}

const paymentVoucher = (guid: string): Record<string, unknown> =>
  voucher(guid, {
    voucherTypeName: 'Payment',
    baseType: 'PAYMENT',
    voucherNumber: '2',
    voucherDate: '2025-04-02',
    partyLedgerName: 'Vendor B',
    amount: '250.50',
    ledgerLines: [
      { ledgerName: 'Vendor B', amount: '250.50', isParty: true },
      { ledgerName: 'Cash', amount: '-250.50' },
    ],
  });

// ---------------------------------------------------------------------------
// TS-S05: registration and signatures
// ---------------------------------------------------------------------------

describe('TS-S05 registration code', () => {
  it('registers once: 201 with the expected company, then the same code is refused', async () => {
    const keys = newKeys();
    const code = await issueCode();
    const first = await rawRegister(code, keys.publicPem);
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      companyId: company.id,
      expectedCompany: {
        tallyName: 'Acme Meats Pvt Ltd',
        companyNumber: '',
        booksFrom: '2025-04-01',
      },
    });
    const again = await rawRegister(code, newKeys().publicPem);
    expect(again.statusCode).toBe(401);
    expect(errorOf(again).code).toBe('UNAUTHENTICATED');
    expect(await count('connector_agent')).toBe(1);
  });

  it('accepts the code with lower case and without dashes', async () => {
    const code = await issueCode();
    const res = await rawRegister(code.replace(/-/g, '').toLowerCase(), newKeys().publicPem);
    expect(res.statusCode).toBe(201);
  });

  it('refuses an expired code, an unknown code and a malformed code with the same answer', async () => {
    const expired = await issueCode();
    await owner.query(
      `UPDATE connector_registration_code SET expires_at = now() - interval '1 second'`,
    );
    const answers = [
      await rawRegister(expired, newKeys().publicPem),
      await rawRegister('ABCD-EFGH-JKMN-PQRS', newKeys().publicPem),
      await rawRegister('short', newKeys().publicPem),
    ];
    for (const res of answers) {
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).message).toBe('Registration code is invalid or expired.');
    }
    expect(await count('connector_agent')).toBe(0);
  });

  it('issuing a new code retires the earlier unused one', async () => {
    const first = await issueCode();
    const second = await issueCode();
    expect((await rawRegister(first, newKeys().publicPem)).statusCode).toBe(401);
    expect((await rawRegister(second, newKeys().publicPem)).statusCode).toBe(201);
  });

  it('stores only a hash of the code, never the clear text, and the audit row has no code', async () => {
    const code = await issueCode();
    const rows = await owner.query<{ code_hash: string }>(
      'SELECT code_hash FROM connector_registration_code',
    );
    expect(rows.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const raw = code.replace(/-/g, '');
    expect(JSON.stringify(rows.rows)).not.toContain(raw);
    const audit = await owner.query<{ after: unknown }>(
      `SELECT after FROM audit_log WHERE action = 'connector.registration_code.issue'`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(raw);
  });

  it('rejects a public key that is not EC P-256 SPKI', async () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ type: 'spki', format: 'pem' })
      .toString();
    const res = await rawRegister(await issueCode(), rsa);
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_FAILED');
    expect(await count('connector_agent')).toBe(0);
  });

  it('rate limits repeated bad codes per IP', async () => {
    for (let i = 0; i < 10; i += 1) {
      expect((await rawRegister('ABCD-EFGH-JKMN-PQRS', newKeys().publicPem)).statusCode).toBe(401);
    }
    const limited = await rawRegister('ABCD-EFGH-JKMN-PQRS', newKeys().publicPem);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('writes audit rows for company, code, registration (agent actor) and revocation', async () => {
    const agent = await registerAgent();
    const revoke = await call(admin, 'POST', `/tally/agents/${agent.id}/revoke`);
    expect(revoke.statusCode).toBe(200);
    const rows = await owner.query<{
      action: string;
      actor_user_id: string | null;
      actor_agent_id: string | null;
    }>(
      `SELECT action, actor_user_id, actor_agent_id FROM audit_log WHERE action LIKE 'tally.%' OR action LIKE 'connector.%' ORDER BY id`,
    );
    expect(rows.rows.map((r) => r.action)).toEqual([
      'tally.company.create',
      'connector.registration_code.issue',
      'connector.agent.register',
      'connector.agent.revoke',
    ]);
    expect(rows.rows[0]?.actor_user_id).not.toBeNull();
    expect(rows.rows[2]?.actor_agent_id).toBe(agent.id);
    expect(rows.rows[2]?.actor_user_id).toBeNull();
  });
});

describe('TS-S05 signed requests', () => {
  it('a valid signed call works (GET and POST, body hash covered)', async () => {
    const agent = await registerAgent();
    const version = await signedCall(agent, 'GET', `${C}/version`);
    expect(version.statusCode, version.body).toBe(200);
    expect(version.json()).toEqual({
      minimumVersion: '0.1.0',
      latestVersion: '0.1.0',
      downloadNote: '',
    });
    const verify = await signedCall(agent, 'POST', `${C}/company/verify`, {
      observed: { tallyName: 'Acme Meats Pvt Ltd', booksFrom: '2025-04-01' },
    });
    expect(verify.statusCode).toBe(200);
  });

  it('every failure is the same generic 401 and nothing is recorded for it', async () => {
    const agent = await registerAgent();
    const other = newKeys();
    const now = Math.floor(Date.now() / 1000);
    const replayNonce = randomUUID();
    expect(
      (await signedCall(agent, 'GET', `${C}/version`, undefined, { nonce: replayNonce }))
        .statusCode,
    ).toBe(200);
    const nonces = await count('connector_nonce');

    const attempts: Record<string, LightMyRequestResponse> = {
      'bad signature (other key)': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        key: other.privateKey,
      }),
      'replayed nonce': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        nonce: replayNonce,
      }),
      'timestamp 10 minutes ahead': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        timestamp: now + 600,
      }),
      'timestamp 10 minutes behind': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        timestamp: now - 600,
      }),
      'tampered body': await signedCall(
        agent,
        'POST',
        `${C}/company/verify`,
        { observed: { tallyName: 'Other', booksFrom: '2025-04-01' } },
        { signedBody: '{"observed":{"tallyName":"Acme Meats Pvt Ltd","booksFrom":"2025-04-01"}}' },
      ),
      'signed for another path': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        signedPath: `${C}/watermarks`,
      }),
      'unknown agent': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        agentId: uuidv7(),
      }),
      'missing signature': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        omit: ['x-signature'],
      }),
      'missing nonce': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        omit: ['x-nonce'],
      }),
      'missing timestamp': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        omit: ['x-timestamp'],
      }),
      'missing agent id': await signedCall(agent, 'GET', `${C}/version`, undefined, {
        omit: ['x-agent-id'],
      }),
      'unsigned bare call': await instance().inject({ method: 'GET', url: `${C}/version` }),
    };
    for (const [name, res] of Object.entries(attempts)) {
      expect(res.statusCode, name).toBe(401);
      expect(errorOf(res).code, name).toBe('UNAUTHENTICATED');
      expect(errorOf(res).message, name).toBe(GENERIC_AUTH_MESSAGE);
    }
    // Only a verified signature consumes a nonce.
    expect(await count('connector_nonce')).toBe(nonces);
  });

  it('timestamps inside the window are accepted', async () => {
    const agent = await registerAgent();
    const now = Math.floor(Date.now() / 1000);
    for (const timestamp of [now - 240, now + 240]) {
      expect(
        (await signedCall(agent, 'GET', `${C}/version`, undefined, { timestamp })).statusCode,
      ).toBe(200);
    }
  });

  it('a garbage JSON body from an unauthenticated caller is 401, not a parse error', async () => {
    const agent = await registerAgent();
    const res = await instance().inject({
      method: 'POST',
      url: `${C}/heartbeat`,
      headers: { 'content-type': 'application/json', 'x-agent-id': agent.id },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).message).toBe(GENERIC_AUTH_MESSAGE);
  });

  it('an authenticated caller with invalid JSON gets VALIDATION_FAILED', async () => {
    const agent = await registerAgent();
    const body = '{not json';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID();
    const canonical = canonicalString({
      method: 'POST',
      path: `${C}/heartbeat`,
      timestamp,
      nonce,
      bodySha256: sha256Hex(body),
    });
    const res = await instance().inject({
      method: 'POST',
      url: `${C}/heartbeat`,
      headers: {
        'content-type': 'application/json',
        'x-agent-id': agent.id,
        'x-timestamp': timestamp,
        'x-nonce': nonce,
        'x-signature': sign('sha256', Buffer.from(canonical), {
          key: agent.privateKey,
          dsaEncoding: 'ieee-p1363',
        }).toString('base64'),
      },
      payload: body,
    });
    expect(res.statusCode).toBe(400);
    expect(errorOf(res).code).toBe('VALIDATION_FAILED');
  });

  it('a revoked agent is refused with the generic answer', async () => {
    const agent = await registerAgent();
    expect((await signedCall(agent, 'GET', `${C}/version`)).statusCode).toBe(200);
    expect((await call(admin, 'POST', `/tally/agents/${agent.id}/revoke`)).statusCode).toBe(200);
    const res = await signedCall(agent, 'GET', `${C}/version`);
    expect(res.statusCode).toBe(401);
    expect(errorOf(res).message).toBe(GENERIC_AUTH_MESSAGE);
  });

  it('every connector route other than register rejects an unsigned call', async () => {
    const routes = instance().routeInventory.filter(
      (r) => r.method !== 'HEAD' && r.url.startsWith('/connector/') && r.url !== `${C}/register`,
    );
    expect(routes.length).toBeGreaterThanOrEqual(8);
    for (const route of routes) {
      const res = await instance().inject({ method: route.method as 'GET', url: route.url });
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(401);
    }
  });

  it('a connector route that forgets connectorSigned cannot be registered', async () => {
    const probe = buildApp({ ...testConfig, DATABASE_URL: urls.app }, { db });
    probe.register((scope, _opts, done) => {
      registerConnectorAuth(scope);
      try {
        scope.get('/connector/v1/oops', { config: { auth: publicRoute() } }, () => ({}));
        done();
      } catch (error) {
        done(error as Error);
      }
    });
    await expect(probe.ready()).rejects.toThrow(/must set config.connectorSigned/);
    await probe.close();
  });
});

// ---------------------------------------------------------------------------
// TS-T11: lease and epoch
// ---------------------------------------------------------------------------

describe('TS-T11 lease and epoch', () => {
  it('the first agent gets epoch 1; a second agent gets LEASE_HELD with the holder', async () => {
    const a = await registerAgent(company.id, 'PC-A');
    const b = await registerAgent(company.id, 'PC-B');
    expect(await lease(a)).toBe(1);
    const held = await acquire(b);
    expect(held.statusCode).toBe(409);
    expect(errorOf(held).code).toBe('LEASE_HELD');
    expect(errorOf(held).details).toMatchObject({ holderAgentId: a.id });
    expect(typeof errorOf(held).details?.expiresAt).toBe('string');
  });

  it('the same agent re-acquiring a live lease keeps its epoch', async () => {
    const a = await registerAgent();
    expect(await lease(a)).toBe(1);
    expect(await lease(a)).toBe(1);
  });

  it('a stale epoch is rejected on every mutating call and nothing is written', async () => {
    const a = await registerAgent();
    const epoch = await lease(a);
    const stale = epoch + 5;
    const calls: [string, unknown][] = [
      [`${C}/lease/release`, { epoch: stale }],
      [
        `${C}/heartbeat`,
        { epoch: stale, tallyReachable: true, companyMatch: true, journalPending: 0 },
      ],
      [
        `${C}/import-batches`,
        {
          batchId: randomUUID(),
          epoch: stale,
          stream: 'VOUCHERS',
          records: [voucher('g-stale')],
        },
      ],
      [
        `${C}/recon-snapshots`,
        {
          batchId: randomUUID(),
          epoch: stale,
          periodFrom: '2025-04-01',
          periodTo: '2025-04-30',
          vouchers: [],
        },
      ],
    ];
    for (const [path, body] of calls) {
      const res = await signedCall(a, 'POST', path, body);
      expect(res.statusCode, path).toBe(409);
      expect(errorOf(res).code, path).toBe('LEASE_STALE');
    }
    expect(await count('tally_voucher')).toBe(0);
    expect(await count('import_batch')).toBe(0);
    expect(await count('connector_heartbeat')).toBe(0);
    expect(await count('sync_watermark')).toBe(0);
  });

  it('takeover after expiry gives the new holder a larger epoch and fences the old one', async () => {
    const a = await registerAgent(company.id, 'PC-A');
    const b = await registerAgent(company.id, 'PC-B');
    const epochA = await lease(a);
    await expireLease();
    const epochB = await lease(b);
    expect(epochB).toBe(epochA + 1);

    const heartbeat = (agent: Agent, epoch: number) =>
      signedCall(agent, 'POST', `${C}/heartbeat`, {
        epoch,
        tallyReachable: true,
        companyMatch: true,
        journalPending: 0,
      });
    const old = await heartbeat(a, epochA);
    expect(old.statusCode).toBe(409);
    expect(errorOf(old).code).toBe('LEASE_STALE');
    expect((await importBatch(a, epochA, 'VOUCHERS', [voucher('g-late')])).statusCode).toBe(409);
    expect(await count('tally_voucher')).toBe(0);
    expect((await heartbeat(b, epochB)).statusCode).toBe(200);
    // And the old holder cannot simply take it back while B is live.
    expect(errorOf(await acquire(a)).code).toBe('LEASE_HELD');
  });

  it('an expired lease makes the same agent re-acquire with a new epoch (TS-T10)', async () => {
    const a = await registerAgent();
    const first = await lease(a);
    await expireLease();
    const stale = await signedCall(a, 'POST', `${C}/heartbeat`, {
      epoch: first,
      tallyReachable: true,
      companyMatch: true,
      journalPending: 0,
    });
    expect(stale.statusCode).toBe(409);
    expect(await lease(a)).toBe(first + 1);
  });

  it('release expires the lease, keeps the epoch counter, and the next holder gets a larger epoch', async () => {
    const a = await registerAgent(company.id, 'PC-A');
    const b = await registerAgent(company.id, 'PC-B');
    const epochA = await lease(a);
    const released = await signedCall(a, 'POST', `${C}/lease/release`, { epoch: epochA });
    expect(released.statusCode).toBe(204);
    expect(await count('connector_lease')).toBe(1);
    expect(await lease(b)).toBe(epochA + 1);
  });

  it('revoking the holder expires its lease at once', async () => {
    const a = await registerAgent(company.id, 'PC-A');
    const b = await registerAgent(company.id, 'PC-B');
    const epochA = await lease(a);
    expect((await call(admin, 'POST', `/tally/agents/${a.id}/revoke`)).statusCode).toBe(200);
    expect(await lease(b)).toBe(epochA + 1);
    // Revoking twice is a no-op.
    expect((await call(admin, 'POST', `/tally/agents/${a.id}/revoke`)).statusCode).toBe(200);
  });

  it('refuses a lease for a fingerprint that is not the company fingerprint', async () => {
    const a = await registerAgent();
    const res = await signedCall(a, 'POST', `${C}/lease/acquire`, {
      companyFingerprint: 'a'.repeat(64),
    });
    expect(res.statusCode).toBe(403);
    expect(errorOf(res).details).toMatchObject({ reason: 'COMPANY_MISMATCH' });
    expect(await count('connector_lease')).toBe(0);
  });

  it('company/verify reports a mismatch for the wrong company and gives a fingerprint that cannot lease', async () => {
    const a = await registerAgent();
    const res = await signedCall(a, 'POST', `${C}/company/verify`, {
      observed: { tallyName: 'Some Other Company', booksFrom: '2025-04-01' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ match: boolean; fingerprint: string }>();
    expect(body.match).toBe(false);
    expect(body.fingerprint).not.toBe(company.fingerprint);
    const leased = await signedCall(a, 'POST', `${C}/lease/acquire`, {
      companyFingerprint: body.fingerprint,
    });
    expect(leased.statusCode).toBe(403);
  });

  it('two agents racing for a free lease: exactly one wins', async () => {
    const a = await registerAgent(company.id, 'PC-A');
    const b = await registerAgent(company.id, 'PC-B');
    const fingerprint = await verifyCompany(a);
    const results = await Promise.all(
      [a, b].map((agent) =>
        signedCall(agent, 'POST', `${C}/lease/acquire`, { companyFingerprint: fingerprint }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
  });

  it('heartbeat renews the lease, records status and returns the posting mode (DISABLED) and no commands', async () => {
    const a = await registerAgent();
    const epoch = await lease(a);
    await owner.query(`UPDATE connector_lease SET expires_at = now() + interval '5 seconds'`);
    const res = await signedCall(a, 'POST', `${C}/heartbeat`, {
      epoch,
      tallyReachable: true,
      tallyVersion: 'TallyPrime 7.0',
      companyMatch: true,
      journalPending: 3,
      lastError: null,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json<{ expiresAt: string; postingMode: string; commands: string[] }>();
    expect(body.postingMode).toBe('DISABLED');
    expect(body.commands).toEqual([]);
    expect(new Date(body.expiresAt).getTime() - Date.now()).toBeGreaterThan(60_000);
    const hb = await owner.query(`SELECT local_queue, tally_version FROM connector_heartbeat`);
    expect(hb.rows).toEqual([{ local_queue: 3, tally_version: 'TallyPrime 7.0' }]);
    const seen = await owner.query<{ last_seen_at: Date | null; last_status: unknown }>(
      `SELECT last_seen_at, last_status FROM connector_agent WHERE id = $1`,
      [a.id],
    );
    expect(seen.rows[0]?.last_seen_at).not.toBeNull();
    expect(seen.rows[0]?.last_status).toMatchObject({ journalPending: 3 });
  });
});

// ---------------------------------------------------------------------------
// Import apply
// ---------------------------------------------------------------------------

describe('import batches', () => {
  let agent: Agent;
  let epoch: number;
  let seen: VouchersImportedEvent[];
  let unhook: () => void;

  beforeEach(async () => {
    agent = await registerAgent();
    epoch = await lease(agent);
    seen = [];
    unhook = onVouchersImported((_tx, event) => {
      seen.push(event);
      return Promise.resolve();
    });
  });

  afterEach(() => unhook());

  it('TS-A08 / TS-A09: a receipt and a payment are imported once even when the batch is resent', async () => {
    const records = [
      voucher('v-receipt', {
        narration: 'Cash from customer [ERP:0197a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b]',
      }),
      paymentVoucher('v-payment'),
    ];
    const batchId = randomUUID();
    const send = (id: string) =>
      importBatch(agent, epoch, 'VOUCHERS', records, {
        batchId: id,
        fromAlterId: 1,
        toAlterId: 20,
      });

    const first = await send(batchId);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ status: 'APPLIED', created: 2, updated: 0, unchanged: 0 });

    // Same batch id again (ack lost): replay of the stored result, nothing written, no second hook run.
    const replay = await send(batchId);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());

    // Same vouchers under a new batch id (journal rebuilt): vouchers unchanged.
    const resent = await send(randomUUID());
    expect(resent.statusCode).toBe(200);
    expect(resent.json()).toEqual({ status: 'APPLIED', created: 0, updated: 0, unchanged: 2 });

    expect(await count('tally_voucher')).toBe(2);
    expect(await count('tally_voucher_ledger_line')).toBe(4);
    expect(await count('import_batch')).toBe(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.vouchers.map((v) => [v.guid, v.isNew])).toEqual([
      ['v-receipt', true],
      ['v-payment', true],
    ]);
    const row = await owner.query(
      `SELECT guid, base_type, voucher_date::text AS d, amount::text AS amount, erp_event_id::text AS erp
       FROM tally_voucher ORDER BY guid`,
    );
    expect(row.rows).toEqual([
      { guid: 'v-payment', base_type: 'PAYMENT', d: '2025-04-02', amount: '250.50', erp: null },
      {
        guid: 'v-receipt',
        base_type: 'RECEIPT',
        d: '2025-04-01',
        amount: '1000.00',
        erp: '0197a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b',
      },
    ]);
  });

  it('a batch id reused with different content is IDEMPOTENCY_MISMATCH and changes nothing', async () => {
    const batchId = randomUUID();
    expect(
      (await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1')], { batchId })).statusCode,
    ).toBe(200);
    const clash = await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1', { amount: '9.00' })], {
      batchId,
    });
    expect(clash.statusCode).toBe(409);
    expect(errorOf(clash).code).toBe('IDEMPOTENCY_MISMATCH');
    const amount = await owner.query<{ a: string }>(`SELECT amount::text AS a FROM tally_voucher`);
    expect(amount.rows[0]?.a).toBe('1000.00');
  });

  it('a changed voucher replaces the stored one (new version) and lines are replaced', async () => {
    await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1')]);
    const changed = voucher('v1', {
      amount: '1200.00',
      ledgerLines: [
        { ledgerName: 'Customer A', amount: '1200.00', isParty: true },
        { ledgerName: 'Bank Account', amount: '-1000.00' },
        { ledgerName: 'Discount Received', amount: '-200.00' },
      ],
    });
    const res = await importBatch(agent, epoch, 'VOUCHERS', [changed]);
    expect(res.json()).toMatchObject({ created: 0, updated: 1, unchanged: 0 });
    expect(await count('tally_voucher')).toBe(1);
    expect(await count('tally_voucher_ledger_line')).toBe(3);
    expect(seen.at(-1)?.vouchers.map((v) => [v.guid, v.isNew])).toEqual([['v1', false]]);
  });

  it('an older alter id does not replace a newer stored voucher; an unknown alter id always compares by content', async () => {
    await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1', { alterId: 50 })]);
    const older = await importBatch(agent, epoch, 'VOUCHERS', [
      voucher('v1', { alterId: 40, amount: '5.00' }),
    ]);
    expect(older.json()).toMatchObject({ updated: 0, unchanged: 1 });
    const unknown = await importBatch(agent, epoch, 'VOUCHERS', [
      voucher('v1', { alterId: null, amount: '7.00' }),
    ]);
    expect(unknown.json()).toMatchObject({ updated: 1 });
    const row = await owner.query<{ a: string }>(`SELECT amount::text AS a FROM tally_voucher`);
    expect(row.rows[0]?.a).toBe('7.00');
  });

  it('inventory lines, cost centres and the ledger guid resolved from mirrored masters are stored', async () => {
    await importBatch(agent, epoch, 'MASTERS', [
      {
        kind: 'LEDGER',
        guid: 'led-customer-a',
        name: 'Customer A',
        parentGroup: 'Sundry Debtors',
        isParty: true,
      },
      { kind: 'STOCK_ITEM', guid: 'si-chicken', name: 'Chicken Whole', unitName: 'Kg' },
    ]);
    const res = await importBatch(agent, epoch, 'VOUCHERS', [
      voucher('v-sale', {
        voucherTypeName: 'Sales',
        baseType: 'SALES',
        ledgerLines: [
          { ledgerName: 'customer a', amount: '500.00', isParty: true },
          {
            ledgerName: 'Sales',
            amount: '-500.00',
            costCentres: [{ costCentre: 'Retail', amount: '-500.00' }],
          },
        ],
        inventoryLines: [
          {
            stockItemName: 'Chicken Whole',
            qty: '12.500',
            uom: 'Kg',
            rate: '40.0000',
            amount: '500.00',
            godown: 'Main',
          },
        ],
      }),
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const detail = await call(admin, 'GET', '/tally/vouchers/v-sale');
    expect(detail.statusCode).toBe(200);
    const body = data<TallyVoucherDetailDto>(detail);
    expect(body.partyLedgerName).toBe('Customer A');
    expect(body.ledgerLines[0]).toMatchObject({
      lineNo: 1,
      ledgerGuid: 'led-customer-a',
      isParty: true,
    });
    expect(body.ledgerLines[1]?.costCentres).toEqual([{ costCentre: 'Retail', amount: '-500.00' }]);
    expect(body.inventoryLines).toEqual([
      expect.objectContaining({
        stockItemName: 'Chicken Whole',
        stockItemGuid: 'si-chicken',
        qty: '12.500',
        rate: '40.0000',
      }),
    ]);
    expect(body.source).toBe('TALLY');
  });

  it('masters upsert by guid (created, updated, unchanged) and party ledgers feed the party table', async () => {
    const ledger = (over: Record<string, unknown> = {}) => ({
      kind: 'LEDGER',
      guid: 'led-1',
      name: 'Customer A',
      parentGroup: 'Sundry Debtors',
      isParty: true,
      gstin: '29ABCDE1234F1Z5',
      openingBalance: '100.00',
      ...over,
    });
    const group = {
      kind: 'GROUP',
      guid: 'grp-1',
      name: 'Sundry Debtors',
      parent: 'Current Assets',
    };
    const first = await importBatch(agent, epoch, 'MASTERS', [
      group,
      ledger(),
      { kind: 'UNIT', guid: 'u-kg', name: 'Kg' },
    ]);
    expect(first.json()).toMatchObject({ created: 3, updated: 0, unchanged: 0 });
    const party = await owner.query(
      `SELECT name, kinds, gstin, source, tally_ledger_guid FROM party`,
    );
    expect(party.rows).toEqual([
      {
        name: 'Customer A',
        kinds: ['CUSTOMER'],
        gstin: '29ABCDE1234F1Z5',
        source: 'TALLY',
        tally_ledger_guid: 'led-1',
      },
    ]);

    const same = await importBatch(agent, epoch, 'MASTERS', [group, ledger()]);
    expect(same.json()).toMatchObject({ created: 0, updated: 0, unchanged: 2 });

    const renamed = await importBatch(agent, epoch, 'MASTERS', [
      ledger({ name: 'Customer A Traders' }),
    ]);
    expect(renamed.json()).toMatchObject({ updated: 1 });
    const after = await owner.query<{ name: string }>(`SELECT name, version FROM party`);
    expect(after.rows[0]?.name).toBe('Customer A Traders');
    expect(await count('tally_ledger')).toBe(1);
  });

  it('an ERP-created party linked to a Tally ledger is not overwritten by the import', async () => {
    await owner.query(
      `INSERT INTO party (id, name, kinds, tally_ledger_guid, source) VALUES ($1, 'My Own Name', '{VENDOR}', 'led-9', 'ERP')`,
      [uuidv7()],
    );
    await importBatch(agent, epoch, 'MASTERS', [
      {
        kind: 'LEDGER',
        guid: 'led-9',
        name: 'Tally Name',
        parentGroup: 'Sundry Creditors',
        isParty: true,
      },
    ]);
    const row = await owner.query(`SELECT name, kinds, source FROM party`);
    expect(row.rows).toEqual([{ name: 'My Own Name', kinds: ['VENDOR'], source: 'ERP' }]);
  });

  it('balances upsert per ledger and date', async () => {
    const balance = (over: Record<string, unknown> = {}) => ({
      ledgerName: 'Bank Account',
      asOf: '2025-04-30',
      closingBalance: '5000.00',
      ...over,
    });
    expect(
      (
        await importBatch(agent, epoch, 'BALANCES', [
          balance(),
          balance({ ledgerName: 'Cash', closingBalance: '10.00' }),
        ])
      ).json(),
    ).toMatchObject({ created: 2 });
    expect((await importBatch(agent, epoch, 'BALANCES', [balance()])).json()).toMatchObject({
      unchanged: 1,
    });
    expect(
      (
        await importBatch(agent, epoch, 'BALANCES', [balance({ closingBalance: '5100.00' })])
      ).json(),
    ).toMatchObject({ updated: 1 });
    expect(
      (await importBatch(agent, epoch, 'BALANCES', [balance({ asOf: '2025-05-31' })])).json(),
    ).toMatchObject({ created: 1 });
    expect(await count('tally_balance_snapshot')).toBe(3);
  });

  it('validation: more than 500 records, bad money, bad base type are 400 and change nothing', async () => {
    const tooMany = Array.from({ length: 501 }, (_, i) => voucher(`bulk-${i}`));
    expect((await importBatch(agent, epoch, 'VOUCHERS', tooMany)).statusCode).toBe(400);
    expect(
      (await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1', { amount: '12.345' })]))
        .statusCode,
    ).toBe(400);
    expect(
      (await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1', { baseType: 'NOPE' })]))
        .statusCode,
    ).toBe(400);
    expect(
      (await importBatch(agent, epoch, 'VOUCHERS', [], { fromAlterId: 9, toAlterId: 3 }))
        .statusCode,
    ).toBe(400);
    expect(await count('tally_voucher')).toBe(0);
    expect(await count('import_batch')).toBe(0);
  });

  it('500 vouchers in one batch apply', async () => {
    const records = Array.from({ length: 500 }, (_, i) =>
      voucher(`bulk-${i}`, { voucherNumber: String(i) }),
    );
    const res = await importBatch(agent, epoch, 'VOUCHERS', records, { toAlterId: 500 });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    expect(await count('tally_voucher')).toBe(500);
    expect(await count('tally_voucher_ledger_line')).toBe(1000);
  });

  it('the watermark advances only for a batch that fully applied', async () => {
    const watermark = async () =>
      (await signedCall(agent, 'GET', `${C}/watermarks`)).json<
        { stream: string; lastAlterId: number; lastFullReconAt: string | null }[]
      >();
    expect(await watermark()).toEqual([
      { stream: 'MASTERS', lastAlterId: 0, lastFullReconAt: null },
      { stream: 'VOUCHERS', lastAlterId: 0, lastFullReconAt: null },
      { stream: 'BALANCES', lastAlterId: 0, lastFullReconAt: null },
    ]);

    expect(
      (
        await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1')], {
          fromAlterId: 1,
          toAlterId: 10,
        })
      ).statusCode,
    ).toBe(200);
    expect((await watermark()).find((w) => w.stream === 'VOUCHERS')?.lastAlterId).toBe(10);

    // A hook that throws rolls the whole batch back: vouchers, batch row and watermark.
    const remove = onVouchersImported(() => Promise.reject(new Error('downstream module failed')));
    const failed = await importBatch(agent, epoch, 'VOUCHERS', [voucher('v2')], {
      fromAlterId: 11,
      toAlterId: 20,
    });
    remove();
    expect(failed.statusCode).toBe(500);
    expect(await count('tally_voucher')).toBe(1);
    expect(await count('import_batch')).toBe(1);
    expect((await watermark()).find((w) => w.stream === 'VOUCHERS')?.lastAlterId).toBe(10);

    // A validation failure and a stale lease do not move it either.
    expect(
      (
        await importBatch(agent, epoch, 'VOUCHERS', [voucher('v3', { amount: 'x' })], {
          toAlterId: 30,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await importBatch(agent, epoch + 1, 'VOUCHERS', [voucher('v3')], { toAlterId: 30 }))
        .statusCode,
    ).toBe(409);
    expect((await watermark()).find((w) => w.stream === 'VOUCHERS')?.lastAlterId).toBe(10);

    // The retry of the failed batch (hook healthy again) applies and moves it; a lower alter id never regresses it.
    expect(
      (
        await importBatch(agent, epoch, 'VOUCHERS', [voucher('v2')], {
          fromAlterId: 11,
          toAlterId: 20,
        })
      ).statusCode,
    ).toBe(200);
    expect((await watermark()).find((w) => w.stream === 'VOUCHERS')?.lastAlterId).toBe(20);
    expect(
      (
        await importBatch(agent, epoch, 'VOUCHERS', [voucher('v4')], {
          fromAlterId: 1,
          toAlterId: 5,
        })
      ).statusCode,
    ).toBe(200);
    expect((await watermark()).find((w) => w.stream === 'VOUCHERS')?.lastAlterId).toBe(20);
  });

  it('works without ALTERID: nulls are accepted, content decides what changed', async () => {
    const batch = [voucher('v1'), voucher('v2', { voucherNumber: '2' })];
    expect((await importBatch(agent, epoch, 'VOUCHERS', batch)).json()).toMatchObject({
      created: 2,
    });
    expect((await importBatch(agent, epoch, 'VOUCHERS', batch)).json()).toMatchObject({
      created: 0,
      unchanged: 2,
    });
    const marks = await owner.query(
      `SELECT last_alter_id::int AS a, last_success_at IS NOT NULL AS ok FROM sync_watermark`,
    );
    expect(marks.rows).toEqual([{ a: 0, ok: true }]);
  });
});

// ---------------------------------------------------------------------------
// Deletion snapshots
// ---------------------------------------------------------------------------

describe('reconciliation snapshots (deleted in Tally)', () => {
  let agent: Agent;
  let epoch: number;

  beforeEach(async () => {
    agent = await registerAgent();
    epoch = await lease(agent);
    await importBatch(agent, epoch, 'VOUCHERS', [
      voucher('a', { voucherDate: '2025-04-05' }),
      voucher('b', { voucherDate: '2025-04-10', voucherNumber: '2' }),
      voucher('c', { voucherDate: '2025-04-20', voucherNumber: '3' }),
      voucher('may', { voucherDate: '2025-05-02', voucherNumber: '4' }),
    ]);
  });

  const snapshot = (guids: string[], over: Record<string, unknown> = {}) =>
    signedCall(agent, 'POST', `${C}/recon-snapshots`, {
      batchId: randomUUID(),
      epoch,
      periodFrom: '2025-04-01',
      periodTo: '2025-04-30',
      vouchers: guids.map((guid) => ({ guid, alterId: null })),
      ...over,
    });

  const flags = async () =>
    Object.fromEntries(
      (
        await owner.query<{ guid: string; d: boolean }>(
          `SELECT guid, is_deleted_in_tally AS d FROM tally_voucher`,
        )
      ).rows.map((r) => [r.guid, r.d]),
    );

  it('marks vouchers missing from the snapshot inside the window, never touching other dates, never deleting rows', async () => {
    const res = await snapshot(['a', 'c']);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ missingMarkedDeleted: 1 });
    expect(await flags()).toEqual({ a: false, b: true, c: false, may: false });
    expect(await count('tally_voucher')).toBe(4);
    expect(await count('tally_voucher_ledger_line')).toBe(8);
  });

  it('is idempotent by batch id and counts a voucher once', async () => {
    const batchId = randomUUID();
    expect((await snapshot(['a', 'c'], { batchId })).json()).toEqual({ missingMarkedDeleted: 1 });
    expect((await snapshot(['a', 'c'], { batchId })).json()).toEqual({ missingMarkedDeleted: 1 });
    expect((await snapshot(['a', 'c'])).json()).toEqual({ missingMarkedDeleted: 0 });
    const clash = await snapshot(['a'], { batchId });
    expect(clash.statusCode).toBe(409);
    expect(errorOf(clash).code).toBe('IDEMPOTENCY_MISMATCH');
  });

  it('a voucher that is listed again is no longer flagged; an empty snapshot flags the whole window', async () => {
    await snapshot(['a', 'c']);
    expect(await flags()).toMatchObject({ b: true });
    await snapshot(['a', 'b', 'c']);
    expect(await flags()).toEqual({ a: false, b: false, c: false, may: false });
    expect((await snapshot([])).json()).toEqual({ missingMarkedDeleted: 3 });
  });

  it('re-importing a flagged voucher clears the flag (it exists in Tally again)', async () => {
    await snapshot(['a', 'c']);
    await importBatch(agent, epoch, 'VOUCHERS', [
      voucher('b', { voucherDate: '2025-04-10', voucherNumber: '2' }),
    ]);
    expect((await flags()).b).toBe(false);
  });

  it('isFull stamps last_full_recon_at; a partial snapshot does not', async () => {
    const fullRecon = async () =>
      (await signedCall(agent, 'GET', `${C}/watermarks`))
        .json<{ stream: string; lastFullReconAt: string | null }[]>()
        .find((w) => w.stream === 'VOUCHERS')?.lastFullReconAt;
    await snapshot(['a', 'b', 'c']);
    expect(await fullRecon()).toBeNull();
    await snapshot(['a', 'b', 'c'], { isFull: true });
    expect(await fullRecon()).not.toBeNull();
  });

  it('the mirror hides deleted vouchers unless asked', async () => {
    await snapshot(['a', 'c']);
    const visible = data<TallyVoucherDto[]>(await call(admin, 'GET', '/tally/vouchers'));
    expect(visible.map((v) => v.guid).sort()).toEqual(['a', 'c', 'may']);
    const all = data<TallyVoucherDto[]>(
      await call(admin, 'GET', '/tally/vouchers?includeDeleted=true'),
    );
    expect(all.find((v) => v.guid === 'b')?.isDeletedInTally).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Admin endpoints
// ---------------------------------------------------------------------------

describe('admin endpoints', () => {
  it('creates a company, refuses a duplicate identity, lists companies', async () => {
    const dup = await call(admin, 'POST', '/tally/companies', {
      displayName: 'Again',
      tallyName: '  acme   meats pvt ltd ',
      booksFrom: '2025-04-01',
    });
    expect(dup.statusCode).toBe(400);
    expect(errorOf(dup).code).toBe('VALIDATION_FAILED');
    const second = await createCompanyViaApi({
      displayName: 'Second',
      tallyName: 'Second Co',
      isTest: false,
    });
    expect(second.postingMode).toBe('DISABLED');
    expect(
      data<TallyCompanyDto[]>(await call(admin, 'GET', '/tally/companies')).map(
        (c) => c.displayName,
      ),
    ).toEqual(['Acme Meats (test)', 'Second']);
    expect(
      (
        await call(admin, 'POST', '/tally/companies', {
          displayName: '',
          tallyName: 'x',
          booksFrom: '2025-04-01',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('the registration code response is never cacheable and an unknown company is 404', async () => {
    const res = await call(admin, 'POST', `/tally/companies/${company.id}/registration-code`);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = data<RegistrationCodeDto>(res);
    expect(body.code).toMatch(/^([A-HJ-KM-NP-Z2-9]{4}-){3}[A-HJ-KM-NP-Z2-9]{4}$/);
    const ttlMs = new Date(body.expiresAt).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(14 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60_000 + 2000);
    expect(
      (await call(admin, 'POST', `/tally/companies/${uuidv7()}/registration-code`)).statusCode,
    ).toBe(404);
    expect(
      (await call(admin, 'POST', `/tally/companies/not-a-uuid/registration-code`)).statusCode,
    ).toBe(404);
  });

  it('lists agents with lease state and revokes one', async () => {
    const a = await registerAgent(company.id, 'PC-A');
    const b = await registerAgent(company.id, 'PC-B');
    await lease(a);
    const agents = data<ConnectorAgentDto[]>(await call(admin, 'GET', '/tally/agents'));
    expect(agents.map((x) => [x.machineName, x.isLeaseHolder, x.status])).toEqual([
      ['PC-A', true, 'ACTIVE'],
      ['PC-B', false, 'ACTIVE'],
    ]);
    expect(JSON.stringify(agents)).not.toContain('BEGIN PUBLIC KEY');
    const revoked = await call(admin, 'POST', `/tally/agents/${b.id}/revoke`);
    expect(data<{ status: string }>(revoked).status).toBe('REVOKED');
    expect((await call(admin, 'POST', `/tally/agents/${uuidv7()}/revoke`)).statusCode).toBe(404);
    const filtered = data<ConnectorAgentDto[]>(
      await call(admin, 'GET', `/tally/agents?companyId=${company.id}`),
    );
    expect(filtered).toHaveLength(2);
  });

  it('status shows lease, heartbeat, watermarks and staleness', async () => {
    const empty = data<TallyStatusDto>(await call(admin, 'GET', '/tally/status')).companies[0];
    expect(empty).toMatchObject({ companyId: company.id, lease: null, lastHeartbeat: null });
    expect(empty?.freshness).toMatchObject({ asOf: null, stale: true, staleAfterHours: 24 });

    const agent = await registerAgent(company.id, 'PC-A');
    const epoch = await lease(agent);
    await signedCall(agent, 'POST', `${C}/heartbeat`, {
      epoch,
      tallyReachable: false,
      tallyVersion: null,
      companyMatch: true,
      journalPending: 4,
      lastError: 'Tally is closed',
    });
    let status = data<TallyStatusDto>(await call(admin, 'GET', '/tally/status')).companies[0];
    expect(status?.lease).toMatchObject({ holderMachineName: 'PC-A', epoch, active: true });
    expect(status?.lastHeartbeat).toMatchObject({
      tallyReachable: false,
      journalPending: 4,
      error: 'Tally is closed',
    });
    expect(status?.freshness.stale).toBe(true);

    await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1')], { toAlterId: 12 });
    status = data<TallyStatusDto>(await call(admin, 'GET', '/tally/status')).companies[0];
    expect(status?.freshness.stale).toBe(true); // BALANCES never succeeded
    await importBatch(agent, epoch, 'BALANCES', [
      { ledgerName: 'Cash', asOf: '2025-04-30', closingBalance: '1.00' },
    ]);
    status = data<TallyStatusDto>(await call(admin, 'GET', '/tally/status')).companies[0];
    expect(status?.freshness.stale).toBe(false);
    expect(status?.freshness.asOf).not.toBeNull();
    expect(status?.watermarks.find((w) => w.stream === 'VOUCHERS')?.lastAlterId).toBe(12);

    // Past the threshold it is stale again.
    await owner.query(
      `UPDATE sync_watermark SET last_success_at = now() - interval '25 hours' WHERE stream = 'BALANCES'`,
    );
    status = data<TallyStatusDto>(await call(admin, 'GET', '/tally/status')).companies[0];
    expect(status?.freshness.stale).toBe(true);
  });

  it('lists ledgers and vouchers with filters and keyset pagination; voucher detail 404s for an unknown guid', async () => {
    const agent = await registerAgent();
    const epoch = await lease(agent);
    await importBatch(agent, epoch, 'MASTERS', [
      { kind: 'LEDGER', guid: 'l1', name: 'Bank Account', parentGroup: 'Bank Accounts' },
      {
        kind: 'LEDGER',
        guid: 'l2',
        name: 'Customer A',
        parentGroup: 'Sundry Debtors',
        isParty: true,
      },
      {
        kind: 'LEDGER',
        guid: 'l3',
        name: 'Customer B',
        parentGroup: 'Sundry Debtors',
        isParty: true,
      },
    ]);
    const page1 = await call(admin, 'GET', '/tally/ledgers?limit=2');
    const first = data<TallyLedgerDto[]>(page1);
    expect(first.map((l) => l.name)).toEqual(['Bank Account', 'Customer A']);
    const cursor = page1.json<{ meta?: { nextCursor?: string } }>().meta?.nextCursor;
    expect(cursor).toBeDefined();
    const page2 = await call(admin, 'GET', `/tally/ledgers?limit=2&cursor=${cursor}`);
    expect(data<TallyLedgerDto[]>(page2).map((l) => l.name)).toEqual(['Customer B']);
    expect(page2.json<{ meta?: unknown }>().meta).toBeUndefined();
    expect(
      data<TallyLedgerDto[]>(
        await call(admin, 'GET', '/tally/ledgers?isParty=true&q=customer'),
      ).map((l) => l.guid),
    ).toEqual(['l2', 'l3']);
    expect(data<TallyLedgerDto[]>(await call(admin, 'GET', '/tally/ledgers?q=%25')).length).toBe(0);
    expect((await call(admin, 'GET', '/tally/ledgers?cursor=garbage')).statusCode).toBe(400);

    await importBatch(agent, epoch, 'VOUCHERS', [
      voucher('v1', { voucherDate: '2025-04-01' }),
      voucher('v2', { voucherDate: '2025-04-15', voucherNumber: '2' }),
      paymentVoucher('v3'),
    ]);
    const all = await call(admin, 'GET', '/tally/vouchers?limit=2');
    expect(data<TallyVoucherDto[]>(all).map((v) => v.guid)).toEqual(['v2', 'v3']); // newest date first
    const next = all.json<{ meta: { nextCursor: string } }>().meta.nextCursor;
    expect(
      data<TallyVoucherDto[]>(
        await call(admin, 'GET', `/tally/vouchers?limit=2&cursor=${next}`),
      ).map((v) => v.guid),
    ).toEqual(['v1']);
    expect(
      data<TallyVoucherDto[]>(await call(admin, 'GET', '/tally/vouchers?baseType=PAYMENT')).map(
        (v) => v.guid,
      ),
    ).toEqual(['v3']);
    expect(
      data<TallyVoucherDto[]>(
        await call(admin, 'GET', '/tally/vouchers?from=2025-04-10&to=2025-04-20'),
      ).map((v) => v.guid),
    ).toEqual(['v2']);
    expect(
      data<TallyVoucherDto[]>(await call(admin, 'GET', '/tally/vouchers?q=vendor')).map(
        (v) => v.guid,
      ),
    ).toEqual(['v3']);
    expect((await call(admin, 'GET', '/tally/vouchers/nope')).statusCode).toBe(404);
    expect((await call(admin, 'GET', '/tally/vouchers?from=2025-13-01')).statusCode).toBe(400);
  });

  it('permissions: a driver is refused everything; dashboard.view reads status only', async () => {
    await mkUser('driver.dan', 'DRIVER');
    const driver = await login('driver.dan');
    for (const [method, url] of [
      ['GET', '/tally/companies'],
      ['POST', '/tally/companies'],
      ['GET', '/tally/agents'],
      ['GET', '/tally/ledgers'],
      ['GET', '/tally/vouchers'],
      ['GET', '/tally/status'],
      ['POST', `/tally/companies/${company.id}/registration-code`],
      ['POST', `/tally/agents/${uuidv7()}/revoke`],
    ] as const) {
      const res = await call(driver, method, url, method === 'POST' ? {} : undefined);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
    }
    // FACTORY_MANAGER holds dashboard.view (division scope) but no tally permission.
    await mkUser('fm.fay', 'FACTORY_MANAGER');
    const manager = await login('fm.fay');
    expect((await call(manager, 'GET', '/tally/status')).statusCode).toBe(200);
    expect((await call(manager, 'GET', '/tally/ledgers')).statusCode).toBe(403);
    expect((await call(manager, 'GET', '/tally/agents')).statusCode).toBe(403);
    // ADMIN manages the connector.
    await mkUser('admin.abe', 'ADMIN');
    const adminUser = await login('admin.abe');
    expect((await call(adminUser, 'GET', '/tally/agents')).statusCode).toBe(200);
    expect((await call(adminUser, 'GET', '/tally/vouchers')).statusCode).toBe(200);
  });

  it('admin routes need a session and the CSRF token', async () => {
    expect(
      (await instance().inject({ method: 'GET', url: `${API}/tally/status` })).statusCode,
    ).toBe(401);
    const noCsrf = await instance().inject({
      method: 'POST',
      url: `${API}/tally/companies`,
      headers: { cookie: admin.cookie },
      payload: { displayName: 'x', tallyName: 'y', booksFrom: '2025-04-01' },
    });
    expect(noCsrf.statusCode).toBe(403);
  });
});

describe('schema', () => {
  it('the application role cannot delete mirror rows or the lease, only flag them', async () => {
    const agent = await registerAgent();
    const epoch = await lease(agent);
    await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1')]);
    for (const table of [
      'tally_voucher',
      'connector_lease',
      'import_batch',
      'tally_company',
      'connector_agent',
    ]) {
      await expect(db.deleteFrom(table as 'tally_voucher').execute(), table).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('a company cannot be PRODUCTION without an owner approval', async () => {
    await expect(
      owner.query(`UPDATE tally_company SET posting_mode = 'PRODUCTION' WHERE id = $1`, [
        company.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('the content hash column exists and is a sha256 for imported vouchers', async () => {
    const agent = await registerAgent();
    const epoch = await lease(agent);
    await importBatch(agent, epoch, 'VOUCHERS', [voucher('v1')]);
    const row = await owner.query<{ h: string }>(`SELECT content_hash AS h FROM tally_voucher`);
    expect(row.rows[0]?.h).toMatch(/^[0-9a-f]{64}$/);
  });
});
