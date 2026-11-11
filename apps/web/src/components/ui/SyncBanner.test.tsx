import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { syncStatusStore } from '../../offline/status';
import { SyncBanner } from './SyncBanner';

afterEach(() => {
  syncStatusStore.set({ online: true, syncing: 0, needsAttention: 0 });
});

describe('SyncBanner', () => {
  it('renders nothing when online with nothing pending', () => {
    const { container } = render(<SyncBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the offline message and reacts to store changes', () => {
    render(<SyncBanner />);
    act(() => syncStatusStore.set({ online: false }));
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i);
    act(() => syncStatusStore.set({ online: true }));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('shows syncing count', () => {
    syncStatusStore.set({ syncing: 3 });
    render(<SyncBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('Syncing 3 items');
  });

  it('needs-attention outranks syncing, offline outranks both', () => {
    syncStatusStore.set({ syncing: 3, needsAttention: 2 });
    render(<SyncBanner />);
    expect(screen.getByRole('status')).toHaveTextContent('2 items need attention');
    act(() => syncStatusStore.set({ online: false }));
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i);
  });
});
