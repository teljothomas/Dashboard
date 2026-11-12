import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import { createQueryClient } from '../app/queryClient';
import { routes } from '../app/routes';
import { authStore, type Identity } from '../features/auth/authStore';
import { sessionStore } from '../lib/session';

export const USER_ID = '01930000-0000-7000-8000-0000000000a1';

export const ALL_PERMISSIONS = [
  'users.manage',
  'roles.manage',
  'audit.view',
  'trip.view',
  'expense.view',
  'expense.approve',
] as const;

export function identityOf(
  permissions: readonly string[],
  options: { mustChangePassword?: boolean; id?: string } = {},
): Identity {
  return {
    user: {
      id: options.id ?? USER_ID,
      username: 'owner1',
      displayName: 'Olivia Owner',
      mustChangePassword: options.mustChangePassword ?? false,
    },
    roles: ['OWNER'],
    permissions: permissions.map((permission) => ({
      permission,
      scope: 'ALL' as const,
      divisionId: null,
    })),
  };
}

/** Back to a fresh page load: nothing known about the user, nothing stored. */
export function resetAuth(): void {
  authStore.set({ status: 'loading', identity: undefined, verified: false, expired: false });
  sessionStore.set({ csrfToken: undefined, userId: undefined });
  window.localStorage.clear();
}

/** Put the app in the signed-in state without a network round trip. */
export function signInAs(
  permissions: readonly string[] = ALL_PERMISSIONS,
  options: { mustChangePassword?: boolean; id?: string } = {},
): void {
  const identity = identityOf(permissions, options);
  sessionStore.set({ csrfToken: 'csrf-test', userId: identity.user.id });
  authStore.set({ status: 'authenticated', identity, verified: true, expired: false });
}

export function renderApp(path: string) {
  // The same client the app uses (401 handling included), without retries so failures show at once.
  const client = createQueryClient({ retry: false });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, router, client };
}

export interface RecordedRequest {
  method: string;
  path: string;
  search: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface MockReply {
  status?: number;
  body?: unknown;
}

export type MockHandler = (request: RecordedRequest) => MockReply | Promise<MockReply>;

/**
 * Replace `fetch` with a router keyed `"METHOD /path"` (path without the `/api/v1` prefix and
 * without the query string). An unhandled request fails the test loudly.
 */
export function mockApi(handlers: Record<string, MockHandler>): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const url = new URL(raw, 'http://localhost');
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1/, '');
      const request: RecordedRequest = {
        method,
        path,
        search: url.search,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
        headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      };
      calls.push(request);
      const handler = handlers[`${method} ${path}`];
      if (handler === undefined) {
        throw new Error(`Unhandled request ${method} ${path}`);
      }
      const reply = await handler(request);
      const status = reply.status ?? 200;
      return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return calls;
}

export function errorBody(code: string, message: string, details?: Record<string, unknown>) {
  return {
    error: { code, message, requestId: 'req-test', ...(details === undefined ? {} : { details }) },
  };
}
