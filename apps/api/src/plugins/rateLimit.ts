import type { FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';

/**
 * In-memory sliding-window limiter (SECURITY section 4: per process, acceptable for one instance).
 * Keeps at most `max` timestamps per key. Login failure lockout is NOT here: it is derived from
 * the persisted `login_attempt` rows so it survives restarts (modules/identity/auth.ts).
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    readonly max: number,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Live timestamps for `key`, dropping the ones that left the window. */
  private live(key: string, at: number): number[] {
    const kept = (this.hits.get(key) ?? []).filter((t) => t > at - this.windowMs);
    if (kept.length === 0) {
      this.hits.delete(key);
    } else {
      this.hits.set(key, kept);
    }
    return kept;
  }

  /** Whole seconds until a hit is allowed again (0 when allowed now). Does not record. */
  peek(key: string): number {
    const at = this.now();
    const kept = this.live(key, at);
    if (kept.length < this.max) return 0;
    const oldest = kept[kept.length - this.max] as number;
    return Math.max(1, Math.ceil((oldest + this.windowMs - at) / 1000));
  }

  /** Record one hit. Returns seconds to wait when the key is over the limit (hit not recorded), else 0. */
  consume(key: string): number {
    const at = this.now();
    this.sweep(at);
    const wait = this.peek(key);
    if (wait > 0) return wait;
    const kept = this.hits.get(key) ?? [];
    kept.push(at);
    this.hits.set(key, kept);
    return 0;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  /** Bound memory: at most one full sweep per window. */
  private sweep(at: number): void {
    if (at - this.lastSweep < this.windowMs) return;
    this.lastSweep = at;
    for (const key of [...this.hits.keys()]) this.live(key, at);
  }
}

export function rateLimited(retryAfterSeconds: number): AppError {
  return new AppError('RATE_LIMITED', 'Too many requests. Try again later.', {
    retryAfterSeconds,
  });
}

/** `preHandler` hook factory: limits every request that reaches the route, by `keyOf(request)`. */
export function rateLimitHook(
  limiter: SlidingWindowLimiter,
  keyOf: (request: FastifyRequest) => string,
): (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void {
  return (request, _reply, done) => {
    const wait = limiter.consume(keyOf(request));
    done(wait > 0 ? rateLimited(wait) : undefined);
  };
}
