import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from './navItems';
import { routes } from './routes';

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return render(<RouterProvider router={router} />);
}

describe('app shell', () => {
  it('renders top bar, content and a bottom nav with at most 5 items', () => {
    renderAt('/');
    expect(screen.getByRole('banner')).toHaveTextContent('TradeX ERP');
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
});
