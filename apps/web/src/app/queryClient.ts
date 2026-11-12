import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { expireSession } from '../features/auth/authStore';
import { ApiError } from '../lib/api';

/** A 401 on any request made while signed in means the session is gone: back to the login page. */
function onRequestError(error: unknown): void {
  if (error instanceof ApiError && error.status === 401) {
    expireSession();
  }
}

export function createQueryClient(options: { retry?: false } = {}): QueryClient {
  return new QueryClient({
    queryCache: new QueryCache({ onError: onRequestError }),
    mutationCache: new MutationCache({ onError: onRequestError }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        // Never retry client errors; the offline layer handles network failures.
        retry:
          options.retry ??
          ((failureCount, error) =>
            !(error instanceof ApiError && error.status < 500) && failureCount < 2),
      },
    },
  });
}
