import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, classifyStaleUpdate, mutationHash } from './policy.js';
import { clearEntities, getEntity, listEntities, registerEntity } from './registry.js';
import { toMutationError } from './locks.js';
import { AppError } from '../../errors.js';
import { z } from 'zod';
import type { SyncEntityHandler } from './types.js';

const noopHandler: SyncEntityHandler = {
  scopes: ['reference'],
  scopeFilter: () => Promise.resolve([]),
  serialize: () => ({}),
};

describe('canonicalJson / mutationHash', () => {
  it('sorts keys recursively and ignores undefined', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"x":2,"y":1}]},"b":1}',
    );
  });

  it('hashes equal content equally regardless of key order', () => {
    const base = { entityType: 'e', entityId: 'id', op: 'UPDATE', baseVersion: 1 };
    expect(mutationHash({ ...base, payload: { a: 1, b: 2 } })).toBe(
      mutationHash({ ...base, payload: { b: 2, a: 1 } }),
    );
  });

  it('hashes different content differently', () => {
    const base = { entityType: 'e', entityId: 'id', op: 'UPDATE', payload: { a: 1 } };
    const h = mutationHash({ ...base, baseVersion: 1 });
    expect(mutationHash({ ...base, baseVersion: 2 })).not.toBe(h);
    expect(mutationHash({ ...base, baseVersion: 1, op: 'CANCEL' })).not.toBe(h);
    expect(mutationHash({ ...base, baseVersion: 1, payload: { a: 2 } })).not.toBe(h);
    expect(mutationHash({ ...base, baseVersion: 1, entityId: 'other' })).not.toBe(h);
  });
});

describe('classifyStaleUpdate', () => {
  const financialFields = ['amount', 'date'];
  const input = {
    baseVersion: 1,
    serverVersion: 3,
    changedKeys: ['note'],
    financialFields,
    serverChangedFields: ['title'],
  };

  it('is FRESH when the base is current', () => {
    expect(classifyStaleUpdate({ ...input, baseVersion: 3, changedKeys: ['amount'] })).toEqual({
      kind: 'FRESH',
    });
  });

  it('is CONFLICT when a stale update touches a financial field, even if disjoint', () => {
    expect(classifyStaleUpdate({ ...input, changedKeys: ['amount', 'note'] })).toEqual({
      kind: 'CONFLICT',
      reason: 'STALE_FINANCIAL_FIELD',
      fields: ['amount'],
    });
  });

  it('is MERGE for stale non-financial keys disjoint from the server changes', () => {
    expect(classifyStaleUpdate(input)).toEqual({ kind: 'MERGE', fields: ['note'] });
  });

  it('is CONFLICT when non-financial keys overlap the server changes', () => {
    expect(
      classifyStaleUpdate({
        ...input,
        changedKeys: ['note', 'title'],
        serverChangedFields: ['title'],
      }),
    ).toEqual({ kind: 'CONFLICT', reason: 'OVERLAPPING_FIELDS', fields: ['title'] });
  });

  it('is CONFLICT when the server changes are unknown', () => {
    expect(classifyStaleUpdate({ ...input, serverChangedFields: null })).toEqual({
      kind: 'CONFLICT',
      reason: 'SERVER_CHANGES_UNKNOWN',
    });
  });

  it('is CONFLICT for a missing or future base version', () => {
    expect(classifyStaleUpdate({ ...input, baseVersion: null }).reason).toBe(
      'BASE_VERSION_INVALID',
    );
    expect(classifyStaleUpdate({ ...input, baseVersion: 9 }).reason).toBe('BASE_VERSION_INVALID');
  });
});

describe('toMutationError', () => {
  it('maps domain errors to a rejection and leaves unexpected ones alone', () => {
    expect(toMutationError(new AppError('RECORD_LOCKED', 'locked'))).toEqual({
      code: 'RECORD_LOCKED',
      message: 'locked',
    });
    expect(toMutationError(Object.assign(new Error('x'), { code: 'TX423' }))?.code).toBe(
      'RECORD_LOCKED',
    );
    const zod = z.object({ amount: z.string() }).safeParse({ amount: 1 });
    expect(zod.success).toBe(false);
    if (!zod.success) {
      expect(toMutationError(zod.error)?.code).toBe('VALIDATION_FAILED');
    }
    expect(toMutationError(new AppError('INTERNAL', 'boom'))).toBeNull();
    expect(toMutationError(new AppError('UNAUTHENTICATED', 'no'))).toBeNull();
    expect(toMutationError(new Error('plain'))).toBeNull();
    expect(toMutationError(Object.assign(new Error('x'), { code: '23505' }))).toBeNull();
  });
});

describe('registry', () => {
  afterEach(() => {
    clearEntities();
  });

  it('registers, looks up and lists in name order', () => {
    registerEntity('zeta', noopHandler);
    registerEntity('alpha', noopHandler);
    expect(getEntity('alpha')).toBe(noopHandler);
    expect(getEntity('missing')).toBeUndefined();
    expect(listEntities().map(([name]) => name)).toEqual(['alpha', 'zeta']);
  });

  it('refuses duplicates and invalid names', () => {
    registerEntity('expense', noopHandler);
    expect(() => registerEntity('expense', noopHandler)).toThrow(/already registered/);
    expect(() => registerEntity('Bad-Name', noopHandler)).toThrow(/Invalid/);
  });
});
