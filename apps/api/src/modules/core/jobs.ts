import { uuidv7 } from '@tradex/domain';
import { AppError } from '../../errors.js';
import { getContext, type Tx } from './context.js';

export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Queue a job in the caller's transaction, so the job exists only if the business write commits
 * (transactional outbox). Returns the job id. `runAt` defaults to now.
 */
export async function enqueue(
  tx: Tx,
  kind: string,
  payload: Record<string, unknown> = {},
  runAt?: Date,
  maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<string> {
  if (kind.length === 0) {
    throw new AppError('VALIDATION_FAILED', 'Job kind is required', { fields: { kind: 'empty' } });
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new AppError('VALIDATION_FAILED', 'maxAttempts must be a positive integer', {
      fields: { maxAttempts: 'invalid' },
    });
  }
  const id = uuidv7();
  await tx
    .insertInto('job')
    .values({
      id,
      kind,
      payload: JSON.stringify(payload),
      max_attempts: maxAttempts,
      created_by: getContext()?.userId ?? null,
      ...(runAt ? { run_at: runAt } : {}),
    })
    .execute();
  return id;
}
