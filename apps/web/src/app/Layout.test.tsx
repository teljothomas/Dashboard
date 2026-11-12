import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, describe, expect, it } from 'vitest';
import { authStore } from '../features/auth/authStore';
import { resetAuth, signInAs } from '../test-utils/auth';
import { NAV_ITEMS } from './navItems';
import { routes } from './routes';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

const EVERYTHING = ['trip.view', 'expense.view', 'expense.approve'];

describe('app shell', () => {
  beforeEach(() => {
    resetAuth();
    signInAs(EVERYTHING);
  });

  it('renders top bar, content and a bottom nav with at most 5 items', () => {
    renderAt('/');
    expect(screen.getByRole('banner')).toHaveTextContent('TradeX ERP');
    expect(screen.getByRole('banner')).toHaveTextContent('Olivia Owner');
    expect(screen.getByRole('main')).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const links = within(nav).getAllByRole('link');
    expect(links.length).toBeLessThanOrEqual(5);
    expect(links).toHaveLength(NAV_ITEMS.length);
  });

  it('marks the current section and navigates between sections', async () => {
    const user = userEvent.setup();
    renderAt('/');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Home');
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('aria-current', 'page');

    await user.click(screen.getByRole('link', { name: 'Trips' }));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Trips');
    expect(screen.getByRole('link', { name: 'Trips' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current');
  });

  it('shows a not-found page for unknown paths inside the shell', () => {
    renderAt('/does-not-exist');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Page not found');
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).toBeInTheDocument();
  });

  it('nav links meet the 44 px touch target class', () => {
    renderAt('/');
    for (const link of within(screen.getByRole('navigation')).getAllByRole('link')) {
      expect(link.className).toContain('min-h-14');
    }
  });

  it('hides sections the user has no permission for, and blocks them by address', () => {
    resetAuth();
    signInAs(['trip.view']);
    renderAt('/');
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(nav).getByRole('link', { name: 'Trips' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Approvals' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Expenses' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'More' })).toBeInTheDocument();
  });

  it('shows "No access" when an unpermitted section is opened by address', () => {
    resetAuth();
    signInAs(['trip.view']);
    renderAt('/approvals');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('No access');
  });

  it('shows the offline notice while the identity is not verified by the server', () => {
    authStore.set({ verified: false });
    renderAt('/');
    expect(screen.getByRole('banner')).toHaveTextContent('working offline');
  });
});
