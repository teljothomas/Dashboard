import { uuidv7 } from '@tradex/domain';
import { AppError } from '../../errors.js';
import { getContext, type Tx } from './context.js';

export interface NotificationInput {
  /** Target one user, a role, or both. At least one is required. */
  userId?: string;
  targetRole?: string;
  kind: string;
  entityType?: string;
  entityId?: string;
  title: string;
  body?: string;
  dueAt?: Date;
}

export interface NotificationView {
  id: string;
  userId: string | null;
  targetRole: string | null;
  kind: string;
  entityType: string | null;
  entityId: string | null;
  title: string;
  body: string | null;
  dueAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface Recipient {
  userId: string;
  roles: readonly string[];
}

export const DEFAULT_LIST_LIMIT = 50;
export const MAX_LIST_LIMIT = 200;

const COLUMNS = [
  'id',
  'user_id',
  'target_role',
  'kind',
  'entity_type',
  'entity_id',
  'title',
  'body',
  'due_at',
  'read_at',
  'created_at',
] as const;

function toView(row: {
  id: string;
  user_id: string | null;
  target_role: string | null;
  kind: string;
  entity_type: string | null;
  entity_id: string | null;
  title: string;
  body: string | null;
  due_at: Date | null;
  read_at: Date | null;
  created_at: Date;
}): NotificationView {
  return {
    id: row.id,
    userId: row.user_id,
    targetRole: row.target_role,
    kind: row.kind,
    entityType: row.entity_type,
    entityId: row.entity_id,
    title: row.title,
    body: row.body,
    dueAt: row.due_at,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

/** Create a notification in the caller's transaction. Returns its id. */
export async function create(tx: Tx, input: NotificationInput): Promise<string> {
  if (input.userId === undefined && input.targetRole === undefined) {
    throw new AppError('VALIDATION_FAILED', 'A notification needs a userId or a targetRole', {
      fields: { userId: 'required unless targetRole is set' },
    });
  }
  const id = uuidv7();
  await tx
    .insertInto('notification')
    .values({
      id,
      user_id: input.userId ?? null,
      target_role: input.targetRole ?? null,
      kind: input.kind,
      entity_type: input.entityType ?? null,
      entity_id: input.entityId ?? null,
      title: input.title,
      body: input.body ?? null,
      due_at: input.dueAt ?? null,
      created_by: getContext()?.userId ?? null,
    })
    .execute();
  return id;
}

export interface ListOptions {
  unreadOnly?: boolean;
  limit?: number;
  /** `nextCursor` of the previous page. */
  cursor?: string;
}

/**
 * Notifications addressed to the user directly or to one of their roles, newest first.
 * Ordered by id (UUID v7, time-ordered), so the cursor is simply the last id of the page.
 * Role-targeted rows carry a single `read_at`: one reader marks it read for the whole role.
 */
export async function listForUser(
  tx: Tx,
  recipient: Recipient,
  options: ListOptions = {},
): Promise<{ items: NotificationView[]; nextCursor?: string }> {
  const limit = Math.min(Math.max(options.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
  let query = tx
    .selectFrom('notification')
    .select(COLUMNS)
    .where((eb) =>
      recipient.roles.length > 0
        ? eb.or([
            eb('user_id', '=', recipient.userId),
            eb('target_role', 'in', [...recipient.roles]),
          ])
        : eb('user_id', '=', recipient.userId),
    );
  if (options.unreadOnly) query = query.where('read_at', 'is', null);
  if (options.cursor) query = query.where('id', '<', options.cursor);
  const rows = await query
    .orderBy('id', 'desc')
    .limit(limit + 1)
    .execute();
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toView),
    ...(rows.length > limit && last ? { nextCursor: last.id } : {}),
  };
}

/** Count unread notifications for the badge. */
export async function countUnread(tx: Tx, recipient: Recipient): Promise<number> {
  const row = await tx
    .selectFrom('notification')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('read_at', 'is', null)
    .where((eb) =>
      recipient.roles.length > 0
        ? eb.or([
            eb('user_id', '=', recipient.userId),
            eb('target_role', 'in', [...recipient.roles]),
          ])
        : eb('user_id', '=', recipient.userId),
    )
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

/**
 * Mark one notification read. Idempotent: an already-read row keeps its original `read_at`.
 * A notification not addressed to the caller is NOT_FOUND (no existence leak).
 */
export async function markRead(
  tx: Tx,
  recipient: Recipient,
  id: string,
): Promise<NotificationView> {
  const visible = await tx
    .selectFrom('notification')
    .select(COLUMNS)
    .where('id', '=', id)
    .where((eb) =>
      recipient.roles.length > 0
        ? eb.or([
            eb('user_id', '=', recipient.userId),
            eb('target_role', 'in', [...recipient.roles]),
          ])
        : eb('user_id', '=', recipient.userId),
    )
    .forUpdate()
    .executeTakeFirst();
  if (!visible) throw new AppError('NOT_FOUND', 'Notification not found');
  if (visible.read_at !== null) return toView(visible);

  const updated = await tx
    .updateTable('notification')
    .set({ read_at: new Date(), updated_by: recipient.userId })
    .where('id', '=', id)
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toView(updated);
}
