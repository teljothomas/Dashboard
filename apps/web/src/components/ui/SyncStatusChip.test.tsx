import { SYNC_STATUSES } from '@tradex/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SyncStatusChip } from './SyncStatusChip';

describe('SyncStatusChip', () => {
  it.each(SYNC_STATUSES)('renders a label for %s and no explanation until tapped', (status) => {
    render(<SyncStatusChip status={status} />);
    const chip = screen.getByRole('button');
    expect(chip).toHaveAttribute('aria-expanded', 'false');
    expect(chip.textContent?.length).toBeGreaterThan(0);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('tap shows the explanation, tap again hides it', async () => {
    const user = userEvent.setup();
    render(<SyncStatusChip status="LOCAL_ONLY" />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('note')).toHaveTextContent(/saved on this phone only/i);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button'));
    expect(screen.queryByRole('note')).toBeNull();
  });
});
