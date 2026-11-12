import { uuidv7 } from '@tradex/domain';
import type { Database } from '../../../db/index.js';
import { AppError } from '../../../errors.js';
import type { RequestContext } from '../../../plugins/requestContext.js';
import * as audit from '../audit.js';
import { type ActorContext, type Tx } from '../context.js';
import { sanitizeFilename, type ProcessedUpload } from './sniff.js';
import { storageKeyFor, type StorageAdapter } from './storage.js';

export const LINK_ROLES = ['BILL', 'PROOF', 'DOC', 'PHOTO'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

/** Who is linking: a full request context, or just the user id (own uploads only). */
export type LinkActor = RequestContext | { userId: string };

async function mayLink(
  tx: Tx,
  actor: LinkActor,
  attachment: { id: string; uploaded_by: string },
): Promise<boolean> {
  if (attachment.uploaded_by === actor.userId) return true;
  return 'grants' in actor && (await canRead(tx, actor, attachment));
}

const ENTITY_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

export interface StoredAttachment {
  id: string;
  sha256: string;
  /** False when the same content was already stored and the existing row was returned. */
  created: boolean;
}

export interface UploadMeta {
  originalName: string | undefined;
  uploadedBy: string;
  deviceId: string | null;
  ctx: ActorContext;
}

/**
 * Persist a validated upload: bytes to storage, then one `attachment` row plus its audit row in a
 * single transaction. The blob is content-addressed and shared, but rows are per uploader
 * (`UNIQUE (sha256, uploaded_by)`): the same user uploading the same bytes again gets their
 * existing id and nothing new is written, while another user gets a row of their own, so nobody is
 * ever handed an id (and the read and link rights that come with it) that belongs to someone
 * else. The storage write comes first and is
 * idempotent: a crash before the commit leaves only an unreferenced file, never a dangling row,
 * and a later upload of the same bytes re-creates a lost file.
 */
export async function saveUpload(
  db: Database,
  storage: StorageAdapter,
  upload: ProcessedUpload,
  meta: UploadMeta,
): Promise<StoredAttachment> {
  const key = storageKeyFor(upload.sha256);
  await storage.put(key, upload.data);

  return db.transaction().execute(async (tx) => {
    const id = uuidv7();
    const originalName = sanitizeFilename(meta.originalName);
    const inserted = await tx
      .insertInto('attachment')
      .values({
        id,
        sha256: upload.sha256,
        mime: upload.mime,
        size_bytes: upload.data.length,
        storage_key: key,
        original_name: originalName,
        uploaded_by: meta.uploadedBy,
        device_id: meta.deviceId,
        // The bytes passed magic-byte sniffing and the image/PDF checks in processUpload.
        scanned_ok: true,
      })
      // Concurrent identical uploads by one user: the loser waits for the winner's commit, then
      // inserts nothing.
      .onConflict((oc) => oc.columns(['sha256', 'uploaded_by']).doNothing())
      .returning('id')
      .executeTakeFirst();

    if (inserted) {
      await audit.record(tx, {
        action: 'ATTACHMENT_UPLOADED',
        entityType: 'attachment',
        entityId: inserted.id,
        after: {
          sha256: upload.sha256,
          mime: upload.mime,
          size_bytes: upload.data.length,
          original_name: originalName,
        },
        ctx: meta.ctx,
      });
      return { id: inserted.id, sha256: upload.sha256, created: true };
    }

    const existing = await tx
      .selectFrom('attachment')
      .select('id')
      .where('sha256', '=', upload.sha256)
      .where('uploaded_by', '=', meta.uploadedBy)
      .executeTakeFirstOrThrow();
    return { id: existing.id, sha256: upload.sha256, created: false };
  });
}

/**
 * `core.attachments.link` (INTERFACES section 7). Links an attachment to a business record in
 * the caller's transaction and audits it there. Idempotent for the same (attachment, entity,
 * role); linking the same pair under a different role is rejected, not overwritten. Whether the
 * caller may attach to that entity is the owning module's decision. This checks the other side:
 * the actor must have uploaded the attachment or be able to read it (`canRead`), otherwise it is
 * NOT_FOUND, so a guessed or leaked id cannot be attached to a record. An actor that is only a
 * `{ userId }` (no resolver context, such as a sync handler) can link its own uploads only.
 */
export async function link(
  tx: Tx,
  attachmentId: string,
  entityType: string,
  entityId: string,
  role: LinkRole,
  actor: LinkActor,
): Promise<void> {
  const fields: Record<string, string> = {};
  if (!ENTITY_TYPE_PATTERN.test(entityType)) fields.entityType = 'invalid';
  if (entityId.length < 1 || entityId.length > 128) fields.entityId = 'invalid';
  if (!(LINK_ROLES as readonly string[]).includes(role)) fields.role = 'invalid';
  if (Object.keys(fields).length > 0) {
    throw new AppError('VALIDATION_FAILED', 'Invalid attachment link', { fields });
  }

  const attachment = await tx
    .selectFrom('attachment')
    .select(['id', 'uploaded_by'])
    .where('id', '=', attachmentId)
    .executeTakeFirst();
  if (!attachment || !(await mayLink(tx, actor, attachment))) {
    throw new AppError('NOT_FOUND', 'Attachment not found');
  }

  const inserted = await tx
    .insertInto('attachment_link')
    .values({
      attachment_id: attachmentId,
      entity_type: entityType,
      entity_id: entityId,
      role,
      created_by: actor.userId,
    })
    .onConflict((oc) => oc.columns(['attachment_id', 'entity_type', 'entity_id']).doNothing())
    .returning('role')
    .executeTakeFirst();

  if (inserted) {
    await audit.record(tx, {
      action: 'ATTACHMENT_LINKED',
      entityType: 'attachment',
      entityId: attachmentId,
      after: { entity_type: entityType, entity_id: entityId, role },
    });
    return;
  }

  const existing = await tx
    .selectFrom('attachment_link')
    .select('role')
    .where('attachment_id', '=', attachmentId)
    .where('entity_type', '=', entityType)
    .where('entity_id', '=', entityId)
    .executeTakeFirstOrThrow();
  if (existing.role !== role) {
    throw new AppError('VALIDATION_FAILED', 'Attachment is already linked with a different role', {
      fields: { role: 'conflict' },
    });
  }
}

/** Decides whether `ctx` may read attachments linked to one entity of the registered type. */
export type AccessResolver = (
  ctx: RequestContext,
  link: { entityId: string; role: LinkRole },
) => boolean | Promise<boolean>;

const resolvers = new Map<string, AccessResolver>();

/**
 * Owning modules register how their entities gate attachment reads (INTERFACES: "scope of linked
 * entity"). One resolver per entity type; registering twice is a programming error. A link whose
 * entity type has no resolver grants nothing (fail closed).
 */
export function registerAccessResolver(entityType: string, resolver: AccessResolver): void {
  if (!ENTITY_TYPE_PATTERN.test(entityType)) {
    throw new Error(`Invalid entity type for access resolver: ${entityType}`);
  }
  if (resolvers.has(entityType)) {
    throw new Error(`Access resolver already registered for ${entityType}`);
  }
  resolvers.set(entityType, resolver);
}

/** Test hook: forget all registered resolvers. */
export function clearAccessResolvers(): void {
  resolvers.clear();
}

/**
 * Read access. An unlinked attachment is visible only to its uploader. A linked one is visible
 * when at least one link's resolver says yes; the uploader gets no special right once it is
 * linked, the entity's own scope rules decide.
 */
export async function canRead(
  db: Tx,
  ctx: RequestContext,
  attachment: { id: string; uploaded_by: string },
): Promise<boolean> {
  const links = await db
    .selectFrom('attachment_link')
    .select(['entity_type', 'entity_id', 'role'])
    .where('attachment_id', '=', attachment.id)
    .execute();
  if (links.length === 0) {
    return attachment.uploaded_by === ctx.userId;
  }
  for (const row of links) {
    const resolver = resolvers.get(row.entity_type);
    if (
      resolver &&
      (await resolver(ctx, { entityId: row.entity_id, role: row.role as LinkRole }))
    ) {
      return true;
    }
  }
  return false;
}
