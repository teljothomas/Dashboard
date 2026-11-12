import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import pg from 'pg';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, resetDatabase, testDbUrls, truncateAll } from '../../../../test/db.js';
import { headerContextProvider } from '../../../../test/requestContext.js';
import { buildApp } from '../../../app.js';
import { createDatabase, type Database } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrate.js';
import { AppError } from '../../../errors.js';
import { testConfig } from '../../../test-config.js';
import { core, runWithContext } from '../index.js';
import { LocalFsStorage } from './storage.js';

const urls = testDbUrls();
const USER = '01930000-0000-7000-8000-000000001001';
const OTHER = '01930000-0000-7000-8000-000000002002';
const DEVICE = '01930000-0000-7000-8000-00000000a001';

let db: Database;
let owner: pg.Pool;
let app: FastifyInstance;
let storageRoot: string;

beforeAll(async () => {
  await resetDatabase(urls);
  await runMigrations(urls.owner, MIGRATIONS_DIR);
  db = createDatabase(urls.app);
  owner = new pg.Pool({ connectionString: urls.owner, max: 2 });
});

beforeEach(async () => {
  await truncateAll(urls);
  core.attachments.clearAccessResolvers();
  storageRoot = await mkdtemp(join(tmpdir(), 'tradex-att-it-'));
  app = buildApp(testConfig, {
    db,
    storage: new LocalFsStorage(storageRoot),
    requestContext: headerContextProvider,
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await rm(storageRoot, { recursive: true, force: true });
});

afterAll(async () => {
  await db.destroy();
  await owner.end();
});

function as(user: string, device?: string): Record<string, string> {
  return { 'x-test-user': user, ...(device ? { 'x-test-device': device } : {}) };
}

interface FormPart {
  data: Buffer;
  filename: string;
  type?: string;
  field?: string;
}

async function multipart(
  parts: FormPart[],
): Promise<{ payload: Buffer; headers: Record<string, string> }> {
  const form = new FormData();
  for (const p of parts) {
    form.append(
      p.field ?? 'file',
      new Blob([new Uint8Array(p.data)], { type: p.type ?? 'application/octet-stream' }),
      p.filename,
    );
  }
  const res = new Response(form);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { 'content-type': res.headers.get('content-type') ?? '' },
  };
}

async function upload(
  parts: FormPart[],
  headers: Record<string, string> = as(USER),
): Promise<LightMyRequestResponse> {
  const body = await multipart(parts);
  return app.inject({
    method: 'POST',
    url: '/api/v1/attachments',
    payload: body.payload,
    headers: { ...body.headers, ...headers },
  });
}

async function jpeg(
  options: { exif?: boolean; orientation?: number; trailer?: string } = {},
): Promise<Buffer> {
  let image = sharp({
    create: { width: 40, height: 20, channels: 3, background: { r: 200, g: 40, b: 40 } },
  });
  if (options.exif) {
    image = image.withExif({
      IFD0: { Copyright: 'secret-copyright', Make: 'SecretCam' },
      IFD3: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
    });
  }
  if (options.orientation) {
    image = image.withMetadata({ orientation: options.orientation });
  }
  const buf = await image.jpeg().toBuffer();
  return options.trailer ? Buffer.concat([buf, Buffer.from(options.trailer)]) : buf;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n');

async function count(table: string): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(rows[0]?.n);
}

describe('POST /api/v1/attachments', () => {
  it('stores a JPEG, returns {id, sha256}, writes the row and one audit row', async () => {
    const res = await upload(
      [{ data: await jpeg(), filename: 'bill.jpg', type: 'image/jpeg' }],
      as(USER, DEVICE),
    );
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; sha256: string }>();
    expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);

    const { rows } = await owner.query('SELECT * FROM attachment');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.id,
      sha256: body.sha256,
      mime: 'image/jpeg',
      original_name: 'bill.jpg',
      uploaded_by: USER,
      device_id: DEVICE,
      scanned_ok: true,
      storage_key: `${body.sha256.slice(0, 2)}/${body.sha256.slice(2, 4)}/${body.sha256}`,
    });
    const audit = await owner.query('SELECT * FROM audit_log');
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      action: 'ATTACHMENT_UPLOADED',
      entity_type: 'attachment',
      entity_id: body.id,
      actor_user_id: USER,
      device_id: DEVICE,
    });
    expect((audit.rows[0] as { request_id: string | null }).request_id).toBeTruthy();
  });

  it('answers 401 without a request context', async () => {
    const body = await multipart([{ data: PDF, filename: 'a.pdf' }]);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/attachments',
      payload: body.payload,
      headers: body.headers,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNAUTHENTICATED');
    expect(await count('attachment')).toBe(0);
  });

  it('TS-S03 spoofed extension: HTML named .jpg with an image content type is 415', async () => {
    const res = await upload([
      {
        data: Buffer.from('<html><script>alert(1)</script></html>'),
        filename: 'evil.jpg',
        type: 'image/jpeg',
      },
    ]);
    expect(res.statusCode).toBe(415);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('UNSUPPORTED_MEDIA');
    expect(await count('attachment')).toBe(0);
  });

  it('TS-S03 spoofed extension: the type comes from the bytes, not the filename', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#00f' } })
      .png()
      .toBuffer();
    const res = await upload([{ data: png, filename: 'report.pdf', type: 'application/pdf' }]);
    expect(res.statusCode).toBe(201);
    const { rows } = await owner.query('SELECT mime, original_name FROM attachment');
    expect(rows[0]).toMatchObject({ mime: 'image/png', original_name: 'report.pdf' });
  });

  it('TS-S03 oversize: one byte over 10 MB is 413 and nothing is stored', async () => {
    const big = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(10 * 1024 * 1024 - 3),
    ]);
    expect(big.length).toBe(10 * 1024 * 1024 + 1);
    const res = await upload([{ data: big, filename: 'big.jpg', type: 'image/jpeg' }]);
    expect(res.statusCode).toBe(413);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('PAYLOAD_TOO_LARGE');
    expect(await count('attachment')).toBe(0);
  });

  it('accepts a PDF of exactly 10 MB', async () => {
    const head = Buffer.from('%PDF-1.4\n');
    const tail = Buffer.from('\n%%EOF\n');
    const pdf = Buffer.concat([
      head,
      Buffer.alloc(10 * 1024 * 1024 - head.length - tail.length, 0x20),
      tail,
    ]);
    expect(pdf.length).toBe(10 * 1024 * 1024);
    const res = await upload([{ data: pdf, filename: 'max.pdf', type: 'application/pdf' }]);
    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;'), 'a.gif'],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'), 'a.svg'],
    ['ZIP', Buffer.from('PK\x03\x04\x14\x00\x00\x00'), 'a.zip'],
    ['Windows executable', Buffer.from('MZ\x90\x00\x03\x00\x00\x00'), 'a.pdf'],
    [
      'PDF with appended HTML',
      Buffer.concat([PDF, Buffer.from('<html><script>alert(1)</script>')]),
      'a.pdf',
    ],
    [
      'PDF with JavaScript',
      Buffer.from('%PDF-1.4\n1 0 obj<</S/JavaScript/JS(x)>>endobj\n%%EOF\n'),
      'a.pdf',
    ],
    [
      'JPEG magic over junk',
      Buffer.concat([
        Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        Buffer.from('<script>alert(1)</script>'),
      ]),
      'a.jpg',
    ],
  ])('TS-S03 polyglot/unknown type: %s is 415', async (_name, data, filename) => {
    const res = await upload([{ data, filename, type: 'image/jpeg' }]);
    expect(res.statusCode).toBe(415);
    expect(await count('attachment')).toBe(0);
  });

  it('strips payloads appended to an image (polyglot) by re-encoding', async () => {
    const res = await upload([
      {
        data: await jpeg({ trailer: '<html><script>alert(1)</script></html>' }),
        filename: 'p.jpg',
      },
    ]);
    expect(res.statusCode).toBe(201);
    const file = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${res.json<{ id: string }>().id}`,
      headers: as(USER),
    });
    expect(file.rawPayload.includes(Buffer.from('<script>'))).toBe(false);
  });

  it('TS-S03 duplicate upload by the same user returns the same id, one row, one audit row', async () => {
    const data = await jpeg();
    const first = await upload([{ data, filename: 'a.jpg' }]);
    const second = await upload([{ data, filename: 'renamed.jpg' }]);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    const id = first.json<{ id: string }>().id;
    expect(second.json<{ id: string }>().id).toBe(id);
    expect(await count('attachment')).toBe(1);
    expect(await count('audit_log')).toBe(1);
  });

  it('another user uploading identical bytes gets an id of their own, sharing one blob', async () => {
    const data = await jpeg();
    const first = await upload([{ data, filename: 'a.jpg' }]);
    const other = await upload([{ data, filename: 'by-other.jpg' }], as(OTHER));
    expect(first.statusCode).toBe(201);
    expect(other.statusCode).toBe(201);
    const firstId = first.json<{ id: string }>().id;
    const otherId = other.json<{ id: string }>().id;
    expect(otherId).not.toBe(firstId);
    const { rows } = await owner.query<{ uploaded_by: string; storage_key: string }>(
      'SELECT uploaded_by, storage_key FROM attachment ORDER BY created_at',
    );
    expect(rows.map((r) => r.uploaded_by)).toEqual([USER, OTHER]);
    expect(rows[0]?.storage_key).toBe(rows[1]?.storage_key);
    // Each user reads their own row and not the other's (both unlinked: uploader only).
    const read = (id: string, user: string): Promise<LightMyRequestResponse> =>
      app.inject({ method: 'GET', url: `/api/v1/attachments/${id}`, headers: as(user) });
    expect((await read(otherId, OTHER)).statusCode).toBe(200);
    expect((await read(firstId, OTHER)).statusCode).toBe(404);
    expect((await read(otherId, USER)).statusCode).toBe(404);
    expect(await count('audit_log')).toBe(2);
  });

  it('concurrent identical uploads converge on one row', async () => {
    const data = await jpeg();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => upload([{ data, filename: 'c.jpg' }])),
    );
    expect(results.every((r) => r.statusCode === 200 || r.statusCode === 201)).toBe(true);
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.json<{ id: string }>().id)).size).toBe(1);
    expect(await count('attachment')).toBe(1);
    expect(await count('audit_log')).toBe(1);
  });

  it('TS-S03 EXIF (incl. GPS) is removed and orientation is applied to the pixels', async () => {
    const original = await jpeg({ exif: true, orientation: 6 });
    const before = await sharp(original).metadata();
    expect(before.exif).toBeDefined();
    expect(before.orientation).toBe(6);

    const res = await upload([{ data: original, filename: 'photo.jpg' }]);
    const id = res.json<{ id: string }>().id;
    const file = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${id}`,
      headers: as(USER),
    });
    const after = await sharp(file.rawPayload).metadata();
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
    // 40x20 rotated by orientation 6 becomes 20x40.
    expect([after.width, after.height]).toEqual([20, 40]);
    expect(file.rawPayload.includes(Buffer.from('secret-copyright'))).toBe(false);
    expect(file.rawPayload.includes(Buffer.from('SecretCam'))).toBe(false);
  });

  it('rejects non-multipart, a missing file, an empty file and extra files', async () => {
    const json = await app.inject({
      method: 'POST',
      url: '/api/v1/attachments',
      payload: { a: 1 },
      headers: as(USER),
    });
    expect(json.statusCode).toBe(415);

    const noFile = await multipart([]);
    const none = await app.inject({
      method: 'POST',
      url: '/api/v1/attachments',
      payload: noFile.payload,
      headers: { ...noFile.headers, ...as(USER) },
    });
    expect(none.statusCode).toBe(400);

    const empty = await upload([{ data: Buffer.alloc(0), filename: 'e.pdf' }]);
    expect(empty.statusCode).toBe(400);

    const two = await upload([
      { data: PDF, filename: 'one.pdf' },
      { data: Buffer.concat([PDF, Buffer.from(' ')]), filename: 'two.pdf' },
    ]);
    expect(two.statusCode).toBe(400);
    expect(await count('attachment')).toBe(0);
  });

  it('never uses the client filename as a path', async () => {
    const res = await upload([{ data: PDF, filename: '../../../etc/passwd' }]);
    expect(res.statusCode).toBe(201);
    const { rows } = await owner.query<{ original_name: string; storage_key: string }>(
      'SELECT original_name, storage_key FROM attachment',
    );
    expect(rows[0]?.original_name).toBe('passwd');
    expect(rows[0]?.storage_key).toMatch(/^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  });
});

describe('GET /api/v1/attachments/:id', () => {
  async function stored(data: Buffer, filename: string): Promise<string> {
    const res = await upload([{ data, filename }]);
    return res.json<{ id: string }>().id;
  }

  it('streams a PDF as an attachment with nosniff, the right type and length', async () => {
    const id = await stored(PDF, 'inv oice.pdf');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${id}`,
      headers: as(USER),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="inv oice\.pdf"/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-length']).toBe(String(PDF.length));
    expect(res.rawPayload.equals(PDF)).toBe(true);
  });

  it('serves images inline with their sniffed type', async () => {
    const id = await stored(await jpeg(), 'p.jpg');
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${id}`,
      headers: as(USER),
    });
    expect(res.headers['content-type']).toBe('image/jpeg');
    expect(res.headers['content-disposition']).toMatch(/^inline;/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('answers 401 without a context and 404 for unknown or malformed ids', async () => {
    const id = await stored(PDF, 'a.pdf');
    expect((await app.inject({ method: 'GET', url: `/api/v1/attachments/${id}` })).statusCode).toBe(
      401,
    );
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/attachments/01930000-0000-7000-8000-0000000000ff',
      headers: as(USER),
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'GET',
      url: '/api/v1/attachments/not-a-uuid',
      headers: as(USER),
    });
    expect(bad.statusCode).toBe(404);
  });

  it('shows an unlinked attachment only to its uploader', async () => {
    const id = await stored(PDF, 'a.pdf');
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/attachments/${id}`, headers: as(USER) }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/attachments/${id}`, headers: as(OTHER) }))
        .statusCode,
    ).toBe(404);
  });

  it('delegates linked attachments to the owning module resolver', async () => {
    const id = await stored(PDF, 'a.pdf');
    const calls: unknown[] = [];
    core.attachments.registerAccessResolver('expense', (ctx, link) => {
      calls.push({ user: ctx.userId, ...link });
      return ctx.userId === OTHER && link.entityId === 'exp-1';
    });
    await db
      .transaction()
      .execute((tx) => core.attachments.link(tx, id, 'expense', 'exp-1', 'BILL', { userId: USER }));

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${id}`,
      headers: as(OTHER),
    });
    expect(allowed.statusCode).toBe(200);
    expect(calls).toContainEqual({ user: OTHER, entityId: 'exp-1', role: 'BILL' });
    // Linked: the uploader has no special right any more, the resolver decides.
    const uploaderDenied = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${id}`,
      headers: as(USER),
    });
    expect(uploaderDenied.statusCode).toBe(404);
  });

  it('denies a link whose entity type has no resolver (fail closed)', async () => {
    const id = await stored(PDF, 'a.pdf');
    await db
      .transaction()
      .execute((tx) => core.attachments.link(tx, id, 'trip', 't-1', 'DOC', { userId: USER }));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${id}`,
      headers: as(USER),
    });
    expect(res.statusCode).toBe(404);
  });

  it('grants access when any one of several links is allowed', async () => {
    const id = await stored(PDF, 'a.pdf');
    core.attachments.registerAccessResolver('expense', () => false);
    core.attachments.registerAccessResolver('trip', () => true);
    await db.transaction().execute(async (tx) => {
      await core.attachments.link(tx, id, 'expense', 'e-1', 'BILL', { userId: USER });
      await core.attachments.link(tx, id, 'trip', 't-1', 'PROOF', { userId: USER });
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${id}`,
      headers: as(OTHER),
    });
    expect(res.statusCode).toBe(200);
  });

  it('answers 500 (not a leak) when the stored file has gone missing', async () => {
    const id = await stored(PDF, 'a.pdf');
    await rm(storageRoot, { recursive: true, force: true });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/attachments/${id}`,
      headers: as(USER),
    });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { code: string } }>().error.code).toBe('INTERNAL');
    // Uploading the same bytes again heals the store.
    expect((await upload([{ data: PDF, filename: 'a.pdf' }])).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/attachments/${id}`, headers: as(USER) }))
        .statusCode,
    ).toBe(200);
  });
});

describe('core.attachments.link', () => {
  async function seed(): Promise<string> {
    const res = await upload([{ data: PDF, filename: 'a.pdf' }]);
    return res.json<{ id: string }>().id;
  }

  async function expectAppError(promise: Promise<unknown>, code: string): Promise<void> {
    const err = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
  }

  it('links, audits in the same transaction and is idempotent', async () => {
    const id = await seed();
    const run = (): Promise<void> =>
      runWithContext({ userId: USER }, () =>
        db
          .transaction()
          .execute((tx) =>
            core.attachments.link(tx, id, 'expense', 'exp-9', 'BILL', { userId: USER }),
          ),
      );
    await run();
    await run();
    const links = await owner.query('SELECT * FROM attachment_link');
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0]).toMatchObject({
      attachment_id: id,
      entity_type: 'expense',
      entity_id: 'exp-9',
      role: 'BILL',
      created_by: USER,
    });
    const audit = await owner.query(`SELECT * FROM audit_log WHERE action = 'ATTACHMENT_LINKED'`);
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({
      entity_id: id,
      actor_user_id: USER,
      after: { entity_type: 'expense', entity_id: 'exp-9', role: 'BILL' },
    });
  });

  it('only the uploader or a user who can read it may link; others get NOT_FOUND', async () => {
    const id = await seed();
    const linkAs = (actor: Parameters<typeof core.attachments.link>[5]): Promise<void> =>
      db
        .transaction()
        .execute((tx) => core.attachments.link(tx, id, 'expense', 'e-7', 'BILL', actor));
    // OTHER did not upload it and has no resolver-granted read: refused, nothing written.
    await expectAppError(linkAs({ userId: OTHER }), 'NOT_FOUND');
    await expectAppError(
      linkAs({
        userId: OTHER,
        deviceId: null,
        permissions: [],
        roles: [],
        grants: [],
        sessionId: null,
        csrfToken: null,
        mustChangePassword: false,
      }),
      'NOT_FOUND',
    );
    expect(await count('attachment_link')).toBe(0);
    expect(await count("audit_log WHERE action = 'ATTACHMENT_LINKED'")).toBe(0);
    // The uploader may.
    await linkAs({ userId: USER });
    expect(await count('attachment_link')).toBe(1);
  });

  it('a user who can read the attachment through an existing link may link it again', async () => {
    const id = await seed();
    core.attachments.registerAccessResolver('expense', (ctx) => ctx.userId === OTHER);
    await db
      .transaction()
      .execute((tx) => core.attachments.link(tx, id, 'expense', 'e-1', 'BILL', { userId: USER }));
    const reader = {
      userId: OTHER,
      deviceId: null,
      permissions: [],
      roles: [],
      grants: [],
      sessionId: null,
      csrfToken: null,
      mustChangePassword: false,
    };
    await db
      .transaction()
      .execute((tx) => core.attachments.link(tx, id, 'trip', 't-1', 'DOC', reader));
    expect(await count('attachment_link')).toBe(2);
  });

  it('rolls the link and its audit row back with the caller transaction', async () => {
    const id = await seed();
    await expect(
      db.transaction().execute(async (tx) => {
        await core.attachments.link(tx, id, 'expense', 'exp-1', 'BILL', { userId: USER });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await count('attachment_link')).toBe(0);
    expect(
      (await owner.query(`SELECT 1 FROM audit_log WHERE action = 'ATTACHMENT_LINKED'`)).rows,
    ).toHaveLength(0);
  });

  it('rejects an unknown attachment, bad arguments and a role change', async () => {
    const id = await seed();
    await expectAppError(
      db
        .transaction()
        .execute((tx) =>
          core.attachments.link(
            tx,
            '01930000-0000-7000-8000-0000000000ff',
            'expense',
            'e',
            'BILL',
            { userId: USER },
          ),
        ),
      'NOT_FOUND',
    );
    await expectAppError(
      db
        .transaction()
        .execute((tx) => core.attachments.link(tx, id, 'Bad Type', 'e', 'BILL', { userId: USER })),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      db
        .transaction()
        .execute((tx) => core.attachments.link(tx, id, 'expense', '', 'BILL', { userId: USER })),
      'VALIDATION_FAILED',
    );
    await expectAppError(
      db
        .transaction()
        .execute((tx) =>
          core.attachments.link(tx, id, 'expense', 'e', 'SELFIE' as never, { userId: USER }),
        ),
      'VALIDATION_FAILED',
    );
    await db
      .transaction()
      .execute((tx) => core.attachments.link(tx, id, 'expense', 'e', 'BILL', { userId: USER }));
    await expectAppError(
      db
        .transaction()
        .execute((tx) => core.attachments.link(tx, id, 'expense', 'e', 'PROOF', { userId: USER })),
      'VALIDATION_FAILED',
    );
    expect(await count('attachment_link')).toBe(1);
  });

  it('registerAccessResolver rejects a second resolver for the same type', () => {
    core.attachments.registerAccessResolver('expense', () => true);
    expect(() => core.attachments.registerAccessResolver('expense', () => true)).toThrow(
      'already registered',
    );
    expect(() => core.attachments.registerAccessResolver('Bad-Type', () => true)).toThrow(
      'Invalid entity type',
    );
  });
});

describe('schema', () => {
  it('enforces size, mime and hash constraints and the link role/uniqueness', async () => {
    const sha = createHash('sha256').update('s').digest('hex');
    const insert = (over: Record<string, unknown>): Promise<unknown> => {
      const row = {
        id: '01930000-0000-7000-8000-0000000000aa',
        sha256: sha,
        mime: 'application/pdf',
        size_bytes: 10,
        storage_key: 'k',
        original_name: 'n',
        uploaded_by: USER,
        ...over,
      };
      return owner.query(
        'INSERT INTO attachment (id, sha256, mime, size_bytes, storage_key, original_name, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [
          row.id,
          row.sha256,
          row.mime,
          row.size_bytes,
          row.storage_key,
          row.original_name,
          row.uploaded_by,
        ],
      );
    };
    await expect(insert({ size_bytes: 10 * 1024 * 1024 + 1 })).rejects.toThrow();
    await expect(insert({ size_bytes: 0 })).rejects.toThrow();
    await expect(insert({ mime: 'image/gif' })).rejects.toThrow();
    await expect(insert({ sha256: 'ABC' })).rejects.toThrow();
    await insert({});
    // Same content by the same uploader is a duplicate; by another uploader it is allowed and
    // shares the blob (same storage_key).
    await expect(
      insert({ id: '01930000-0000-7000-8000-0000000000bb', storage_key: 'k2' }),
    ).rejects.toThrow(/unique/i);
    await insert({ id: '01930000-0000-7000-8000-0000000000cc', uploaded_by: OTHER });
  });
});
