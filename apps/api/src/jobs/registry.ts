import type { Database } from '../db/index.js';

/** A claimed job as handed to a handler. `attempt` is 1-based and already counts this run. */
export interface JobRecord {
  id: string;
  kind: string;
  payload: unknown;
  attempt: number;
  maxAttempts: number;
}

/**
 * Handlers do their own work with `db` (opening a transaction when they need one). Throwing marks
 * the attempt failed and schedules a retry; returning marks the job DONE. Handlers must be
 * idempotent: a job can run again after a crash or a lost lock.
 */
export type JobHandler = (job: JobRecord, db: Database) => Promise<void>;

export class JobRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  register(kind: string, handler: JobHandler): this {
    if (this.handlers.has(kind)) {
      throw new Error(`Job handler already registered for kind ${kind}`);
    }
    this.handlers.set(kind, handler);
    return this;
  }

  get(kind: string): JobHandler | undefined {
    return this.handlers.get(kind);
  }

  kinds(): string[] {
    return [...this.handlers.keys()];
  }
}
