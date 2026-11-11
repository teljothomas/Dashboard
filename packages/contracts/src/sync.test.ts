import { describe, expect, it } from 'vitest';
import {
  ConflictListQuery,
  MAX_PUSH_MUTATIONS,
  PullQuery,
  PushRequest,
  ResolveConflictRequest,
} from './sync.js';

const id = (n: number): string => `01930000-0000-7000-8000-${String(n).padStart(12, '0')}`;

function mutation(n: number) {
  return {
    mutationId: id(n),
    entityType: 'expense',
    entityId: id(1000 + n),
    op: 'CREATE' as const,
    baseVersion: null,
    clientCreatedAt: '2026-11-11T10:00:00Z',
    payload: { amount: '10.00' },
  };
}

describe('PushRequest', () => {
  it('accepts 1..50 mutations', () => {
    for (const n of [1, MAX_PUSH_MUTATIONS]) {
      const mutations = Array.from({ length: n }, (_, i) => mutation(i + 1));
      expect(PushRequest.safeParse({ deviceId: id(9), mutations }).success).toBe(true);
    }
  });

  it('rejects 0 and 51 mutations, bad ids, ops and entity types', () => {
    const many = Array.from({ length: MAX_PUSH_MUTATIONS + 1 }, (_, i) => mutation(i + 1));
    expect(PushRequest.safeParse({ deviceId: id(9), mutations: [] }).success).toBe(false);
    expect(PushRequest.safeParse({ deviceId: id(9), mutations: many }).success).toBe(false);
    const base = { deviceId: id(9) };
    expect(
      PushRequest.safeParse({ ...base, mutations: [{ ...mutation(1), op: 'DELETE' }] }).success,
    ).toBe(false);
    expect(
      PushRequest.safeParse({ ...base, mutations: [{ ...mutation(1), entityType: 'Bad-Type' }] })
        .success,
    ).toBe(false);
    expect(
      PushRequest.safeParse({ ...base, mutations: [{ ...mutation(1), mutationId: 'x' }] }).success,
    ).toBe(false);
    expect(
      PushRequest.safeParse({
        ...base,
        mutations: [{ ...mutation(1), clientCreatedAt: 'yesterday' }],
      }).success,
    ).toBe(false);
  });
});

describe('PullQuery', () => {
  it('coerces text query values and applies defaults', () => {
    expect(PullQuery.parse({ scope: 'mine' })).toEqual({ scope: 'mine', cursor: 0, limit: 500 });
    expect(PullQuery.parse({ scope: 'reference', cursor: '42', limit: '10' })).toEqual({
      scope: 'reference',
      cursor: 42,
      limit: 10,
    });
  });

  it('rejects an unknown scope and out-of-range numbers', () => {
    expect(PullQuery.safeParse({ scope: 'all' }).success).toBe(false);
    expect(PullQuery.safeParse({ scope: 'mine', limit: '501' }).success).toBe(false);
    expect(PullQuery.safeParse({ scope: 'mine', limit: '0' }).success).toBe(false);
    expect(PullQuery.safeParse({ scope: 'mine', cursor: '-1' }).success).toBe(false);
    expect(PullQuery.safeParse({ scope: 'mine', cursor: '1.5' }).success).toBe(false);
  });
});

describe('ResolveConflictRequest', () => {
  it('requires values for MERGED only', () => {
    expect(ResolveConflictRequest.safeParse({ resolution: 'KEEP_SERVER' }).success).toBe(true);
    expect(
      ResolveConflictRequest.safeParse({ resolution: 'APPLY_CLIENT', note: 'ok' }).success,
    ).toBe(true);
    expect(ResolveConflictRequest.safeParse({ resolution: 'MERGED' }).success).toBe(false);
    expect(ResolveConflictRequest.safeParse({ resolution: 'MERGED', values: {} }).success).toBe(
      false,
    );
    expect(
      ResolveConflictRequest.safeParse({ resolution: 'MERGED', values: { amount: '1.00' } })
        .success,
    ).toBe(true);
    expect(
      ResolveConflictRequest.safeParse({ resolution: 'KEEP_SERVER', values: { a: 1 } }).success,
    ).toBe(false);
  });
});

describe('ConflictListQuery', () => {
  it('defaults to OPEN with limit 50', () => {
    expect(ConflictListQuery.parse({})).toEqual({ status: 'OPEN', limit: 50 });
    expect(ConflictListQuery.parse({ status: 'ALL', limit: '5' }).status).toBe('ALL');
    expect(ConflictListQuery.safeParse({ limit: '201' }).success).toBe(false);
  });
});
