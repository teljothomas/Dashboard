import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { errorBody, mockApi, resetAuth, signInAs } from '../../test-utils/auth';
import { authStore } from './authStore';
import { SignOutButton } from './SignOutButton';

const counts = vi.hoisted(() => ({ value: { syncing: 0, needsAttention: 0 } }));

vi.mock('../../offline/outbox', () => ({
  outboxCounts: vi.fn(() => Promise.resolve(counts.value)),
}));
vi.mock('../../offline/runtime', () => ({
  getOfflineRuntime: () => ({ db: {}, engine: {} }),
}));

beforeEach(() => {
  resetAuth();
  signInAs(['trip.view']);
  counts.value = { syncing: 0, needsAttention: 0 };
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('SignOutButton', () => {
  it('signs out at once when nothing is waiting to upload', async () => {
    const user = userEvent.setup();
    const calls = mockApi({ 'POST /auth/logout': () => ({ body: { data: { ok: true } } }) });
    render(<SignOutButton />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => {
      expect(authStore.get().status).toBe('anonymous');
    });
    expect(calls).toHaveLength(1);
  });

  it('warns with the count when items are waiting, and signs out only after confirmation', async () => {
    const user = userEvent.setup();
    counts.value = { syncing: 2, needsAttention: 1 };
    const calls = mockApi({ 'POST /auth/logout': () => ({ body: { data: { ok: true } } }) });
    render(<SignOutButton />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('alertdialog')).toHaveTextContent(
      '3 items have not uploaded yet',
    );
    expect(screen.getByRole('alertdialog')).toHaveTextContent('stay on this phone');
    expect(calls).toHaveLength(0);
    expect(authStore.get().status).toBe('authenticated');

    await user.click(screen.getByRole('button', { name: 'Sign out anyway' }));
    await waitFor(() => {
      expect(authStore.get().status).toBe('anonymous');
    });
    expect(calls).toHaveLength(1);
  });

  it('can be cancelled from the warning', async () => {
    const user = userEvent.setup();
    counts.value = { syncing: 1, needsAttention: 0 };
    const calls = mockApi({});
    render(<SignOutButton />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(await screen.findByRole('button', { name: 'Stay signed in' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(authStore.get().status).toBe('authenticated');
    expect(calls).toHaveLength(0);
  });

  it('stays signed in and says why when the server cannot be reached', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('offline'))),
    );
    render(<SignOutButton />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Signing out needs a connection');
    expect(authStore.get().status).toBe('authenticated');
  });

  it('shows a generic error for a server failure', async () => {
    const user = userEvent.setup();
    mockApi({
      'POST /auth/logout': () => ({ status: 500, body: errorBody('INTERNAL', 'Boom') }),
    });
    render(<SignOutButton />);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong');
    expect(authStore.get().status).toBe('authenticated');
  });
});
