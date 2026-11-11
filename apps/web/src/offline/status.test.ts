import type { SyncStatus } from '@tradex/contracts';
import { describe, expect, it } from 'vitest';
import {
  deriveSyncStatus,
  needsAttention,
  UNCERTAIN_RECONCILE_AFTER_MS,
  type StatusInput,
} from './status';

const NOW = 1_800_000_000_000;
const none: StatusInput['mutations'] = [];

describe('deriveSyncStatus: one case per row of the SYNC_DESIGN 2.4 table', () => {
  it('LOCAL_ONLY: unacknowledged PENDING mutation', () => {
    expect(deriveSyncStatus({ mutations: [{ state: 'PENDING' }] })).toBe('LOCAL_ONLY');
  });

  it('LOCAL_ONLY: SENDING mutation (no ack yet)', () => {
    expect(deriveSyncStatus({ mutations: [{ state: 'SENDING' }] })).toBe('LOCAL_ONLY');
  });

  it('FAILED: last push REJECTED with a validation error', () => {
    expect(
      deriveSyncStatus({ mutations: [{ state: 'REJECTED', errorCode: 'VALIDATION_FAILED' }] }),
    ).toBe('FAILED');
  });

  it('FAILED: attachment failed permanently', () => {
    expect(deriveSyncStatus({ mutations: none, attachmentFailed: true })).toBe('FAILED');
  });

  it('REQUIRES_RECONCILIATION: CONFLICT mutation', () => {
    expect(deriveSyncStatus({ mutations: [{ state: 'CONFLICT' }] })).toBe(
      'REQUIRES_RECONCILIATION',
    );
  });

  it('REQUIRES_RECONCILIATION: RECORD_LOCKED rejection', () => {
    expect(
      deriveSyncStatus({ mutations: [{ state: 'REJECTED', errorCode: 'RECORD_LOCKED' }] }),
    ).toBe('REQUIRES_RECONCILIATION');
  });

  it('REQUIRES_RECONCILIATION: open sync_conflict on the server', () => {
    expect(deriveSyncStatus({ mutations: none, server: { openConflict: true } })).toBe(
      'REQUIRES_RECONCILIATION',
    );
  });

  it.each(['REJECTED', 'DEAD', 'ALTERED_IN_TALLY'])(
    'REQUIRES_RECONCILIATION: posting %s',
    (postingStatus) => {
      expect(
        deriveSyncStatus({ mutations: none, server: { status: 'APPROVED', postingStatus } }),
      ).toBe('REQUIRES_RECONCILIATION');
    },
  );

  it('REQUIRES_RECONCILIATION: UNCERTAIN for more than 24 h', () => {
    expect(
      deriveSyncStatus({
        mutations: none,
        nowMs: NOW,
        server: {
          status: 'APPROVED',
          postingStatus: 'UNCERTAIN',
          uncertainSinceMs: NOW - UNCERTAIN_RECONCILE_AFTER_MS - 1,
        },
      }),
    ).toBe('REQUIRES_RECONCILIATION');
  });

  it('REQUIRES_RECONCILIATION: server computed it', () => {
    expect(
      deriveSyncStatus({ mutations: none, server: { syncStatus: 'REQUIRES_RECONCILIATION' } }),
    ).toBe('REQUIRES_RECONCILIATION');
  });

  it('AWAITING_APPROVAL: server status SUBMITTED', () => {
    expect(deriveSyncStatus({ mutations: none, server: { status: 'SUBMITTED' } })).toBe(
      'AWAITING_APPROVAL',
    );
  });

  it.each([
    'PENDING',
    'READY',
    'BLOCKED_MAPPING',
    'BLOCKED_VALIDATION',
    'CLAIMED',
    'FAILED_RETRYABLE',
    'UNCERTAIN',
  ])('AWAITING_TALLY: APPROVED with posting %s', (postingStatus) => {
    expect(
      deriveSyncStatus({
        mutations: none,
        nowMs: NOW,
        // UNCERTAIN for exactly 24 h is still within the window (the rule is "> 24 h").
        server: {
          status: 'APPROVED',
          postingStatus,
          uncertainSinceMs: NOW - UNCERTAIN_RECONCILE_AFTER_MS,
        },
      }),
    ).toBe('AWAITING_TALLY');
  });

  it('POSTED_TO_TALLY: posting POSTED_VERIFIED', () => {
    expect(
      deriveSyncStatus({
        mutations: none,
        server: { status: 'APPROVED', postingStatus: 'POSTED_VERIFIED' },
      }),
    ).toBe('POSTED_TO_TALLY');
  });

  it('SYNCED: on the server, no approval or posting involved', () => {
    expect(deriveSyncStatus({ mutations: none, server: { status: 'DRAFT' } })).toBe('SYNCED');
    expect(deriveSyncStatus({ mutations: none })).toBe('SYNCED');
  });
});

describe('deriveSyncStatus: server-computed status passes through', () => {
  it.each<SyncStatus>([
    'SYNCED',
    'AWAITING_APPROVAL',
    'AWAITING_TALLY',
    'POSTED_TO_TALLY',
    'FAILED',
  ])('%s', (syncStatus) => {
    expect(deriveSyncStatus({ mutations: none, server: { syncStatus } })).toBe(syncStatus);
  });

  it('a server LOCAL_ONLY is never shown for a record the server holds', () => {
    expect(deriveSyncStatus({ mutations: none, server: { syncStatus: 'LOCAL_ONLY' } })).toBe(
      'SYNCED',
    );
  });
});

describe('deriveSyncStatus: precedence (top beats bottom)', () => {
  it('LOCAL_ONLY beats everything the server says', () => {
    expect(
      deriveSyncStatus({
        mutations: [{ state: 'PENDING' }],
        server: { syncStatus: 'POSTED_TO_TALLY', openConflict: true },
      }),
    ).toBe('LOCAL_ONLY');
  });

  it('FAILED beats REQUIRES_RECONCILIATION', () => {
    expect(
      deriveSyncStatus({
        mutations: [{ state: 'REJECTED', errorCode: 'VALIDATION_FAILED' }],
        server: { openConflict: true },
      }),
    ).toBe('FAILED');
    expect(
      deriveSyncStatus({
        mutations: [{ state: 'CONFLICT' }],
        attachmentFailed: true,
      }),
    ).toBe('FAILED');
  });

  it('REQUIRES_RECONCILIATION beats AWAITING_APPROVAL / AWAITING_TALLY / POSTED_TO_TALLY', () => {
    for (const status of ['SUBMITTED', 'APPROVED']) {
      expect(deriveSyncStatus({ mutations: none, server: { status, openConflict: true } })).toBe(
        'REQUIRES_RECONCILIATION',
      );
    }
    expect(
      deriveSyncStatus({
        mutations: none,
        server: { syncStatus: 'POSTED_TO_TALLY', openConflict: true },
      }),
    ).toBe('REQUIRES_RECONCILIATION');
  });

  it('AWAITING_APPROVAL beats AWAITING_TALLY and POSTED_TO_TALLY when both fields are set', () => {
    expect(
      deriveSyncStatus({
        mutations: none,
        server: { status: 'SUBMITTED', postingStatus: 'POSTED_VERIFIED' },
      }),
    ).toBe('AWAITING_APPROVAL');
  });

  it('a mutation queued behind a CONFLICT/REJECTED one does not count as LOCAL_ONLY', () => {
    expect(deriveSyncStatus({ mutations: [{ state: 'CONFLICT' }, { state: 'PENDING' }] })).toBe(
      'REQUIRES_RECONCILIATION',
    );
    expect(
      deriveSyncStatus({
        mutations: [{ state: 'REJECTED', errorCode: 'VALIDATION_FAILED' }, { state: 'PENDING' }],
      }),
    ).toBe('FAILED');
  });
});

describe('needsAttention', () => {
  it('is true only for FAILED and REQUIRES_RECONCILIATION', () => {
    const all: SyncStatus[] = [
      'LOCAL_ONLY',
      'SYNCED',
      'AWAITING_APPROVAL',
      'AWAITING_TALLY',
      'POSTED_TO_TALLY',
      'FAILED',
      'REQUIRES_RECONCILIATION',
    ];
    expect(all.filter(needsAttention)).toEqual(['FAILED', 'REQUIRES_RECONCILIATION']);
  });
});
