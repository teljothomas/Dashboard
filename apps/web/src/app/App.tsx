import { useEffect } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { authStore, loadSession } from '../features/auth/authStore';
import { useStore } from '../lib/store';
import { getOfflineRuntime, startOfflineRuntime } from '../offline/runtime';
import { startConnectivityMonitor } from '../offline/status';
import { createQueryClient } from './queryClient';
import { routes } from './routes';

const queryClient = createQueryClient();

const router = createBrowserRouter(routes);

const REVERIFY_INTERVAL_MS = 30_000;

/**
 * Ties the offline runtime and cached server data to the signed-in user: sync runs only while
 * signed in, resumes after a 401 pause once the same or another user signs in again (the outbox
 * only ever sends the signed-in user's mutations), and nothing from one user's session survives
 * in the query cache for the next.
 */
function SessionEffects() {
  const client = useQueryClient();
  const status = useStore(authStore, (s) => s.status);
  const verified = useStore(authStore, (s) => s.verified);
  const userId = useStore(authStore, (s) => s.identity?.user.id);

  useEffect(() => {
    if (status !== 'authenticated') return undefined;
    return startOfflineRuntime();
  }, [status]);

  useEffect(() => {
    if (status !== 'authenticated' || !verified) return;
    const { engine } = getOfflineRuntime();
    // Paused after a 401: resume. Otherwise (offline start, now verified) just run once.
    void (engine.isPaused() ? engine.resume() : engine.trigger('online'));
  }, [status, verified, userId]);

  useEffect(() => {
    if (status === 'anonymous') client.clear();
  }, [status, client]);

  // An identity read from the local copy (server unreachable) is checked again when possible.
  useEffect(() => {
    if (status !== 'authenticated' || verified) return undefined;
    const recheck = (): void => {
      if (navigator.onLine) void loadSession();
    };
    window.addEventListener('online', recheck);
    const timer = window.setInterval(recheck, REVERIFY_INTERVAL_MS);
    return () => {
      window.removeEventListener('online', recheck);
      window.clearInterval(timer);
    };
  }, [status, verified]);

  return null;
}

export function App() {
  useEffect(() => startConnectivityMonitor(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <SessionEffects />
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
