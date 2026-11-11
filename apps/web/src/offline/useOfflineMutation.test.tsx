import { act, renderHook } from '@testing-library/react';
import { uuidv7 } from '@tradex/domain';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { TradexOfflineDb } from './db';
import { useOfflineMutation, type OfflineMutationDeps } from './useOfflineMutation';

let db: TradexOfflineDb;
let dbName: string;
let triggerSync: Mock<() => void>;
let deps: OfflineMutationDeps;
let userId: string | undefined;

beforeEach(() => {
  dbName = `tradex-hook-${uuidv7()}`;
  db = new TradexOfflineDb(dbName);
  triggerSync = vi.fn<() => void>();
  userId = 'u1';
  deps = { db, triggerSync, getUserId: () => userId };
});

afterEach(async () => {
  db.close();
  await TradexOfflineDb.delete(dbName);
});

describe('useOfflineMutation', () => {
  it('saves locally, queues the mutation, then triggers a sync without waiting for it', async () => {
    const { result } = renderHook(() => useOfflineMutation('expense', deps));

    let saved: Awaited<ReturnType<typeof result.current.mutateAsync>> | undefined;
    await act(async () => {
      saved = await result.current.mutateAsync({ payload: { amount: '12.50' } });
    });

    expect(saved?.entry).toMatchObject({ op: 'CREATE', userId: 'u1', entityType: 'expense' });
    expect(saved?.entityId).toMatch(/^[0-9a-f-]{36}$/);
    expect(await db.outbox.count()).toBe(1);
    expect(await db.records.get(['expense', saved?.entityId ?? ''])).toMatchObject({
      status: 'LOCAL_ONLY',
      data: { amount: '12.50' },
    });
    expect(triggerSync).toHaveBeenCalledTimes(1);
    expect(result.current.isPending).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('an existing entityId means UPDATE; SUBMIT keeps the local data', async () => {
    const { result } = renderHook(() => useOfflineMutation('expense', deps));
    let id = '';
    await act(async () => {
      id = (await result.current.mutateAsync({ payload: { amount: '1.00' } })).entityId;
    });
    await act(async () => {
      await result.current.mutateAsync({ entityId: id, payload: { note: 'n' } });
      await result.current.mutateAsync({ entityId: id, op: 'SUBMIT', payload: {} });
    });

    const entries = await db.outbox.orderBy('createdAt').toArray();
    expect(entries.map((e) => e.op)).toEqual(['CREATE', 'UPDATE', 'SUBMIT']);
    expect(entries[1]?.baseVersion).toBeNull(); // queued behind the unacknowledged CREATE
    expect((await db.records.get(['expense', id]))?.data).toEqual({ amount: '1.00', note: 'n' });
  });

  it('refuses to save without a signed-in user and queues nothing', async () => {
    userId = undefined;
    const { result } = renderHook(() => useOfflineMutation('expense', deps));

    await act(async () => {
      await expect(result.current.mutateAsync({ payload: {} })).rejects.toMatchObject({
        code: 'NO_SESSION',
      });
    });

    expect(await db.outbox.count()).toBe(0);
    expect(triggerSync).not.toHaveBeenCalled();
    expect(result.current.error).toMatchObject({ code: 'NO_SESSION' });
    act(() => result.current.reset());
    expect(result.current.error).toBeNull();
  });

  it('a failing trigger never loses the saved data', async () => {
    triggerSync.mockImplementation(() => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useOfflineMutation('expense', deps));
    await act(async () => {
      await result.current.mutateAsync({ payload: { amount: '3.00' } });
    });
    expect(await db.outbox.count()).toBe(1);
  });
});
