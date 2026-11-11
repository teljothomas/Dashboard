import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, ApiNetworkError, api } from './api';
import { sessionStore } from './session';

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function lastCall(): { url: string; init: RequestInit; headers: Headers } {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error('fetch was not called');
  const [url, init] = call;
  return {
    url: typeof url === 'string' ? url : '(non-string url)',
    init: init ?? {},
    headers: new Headers(init?.headers),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  sessionStore.set({ csrfToken: undefined });
});

afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe('apiRequest', () => {
  it('GET returns data and meta, sends credentials and X-Device-Id, no CSRF', async () => {
    sessionStore.set({ csrfToken: 'csrf-abc' });
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { data: [1, 2], meta: { nextCursor: 'c1' } }),
    );

    const result = await api.get<number[]>('/things');

    expect(result.data).toEqual([1, 2]);
    expect(result.meta).toEqual({ nextCursor: 'c1' });
    const { url, init, headers } = lastCall();
    expect(url).toBe('/api/v1/things');
    expect(init.credentials).toBe('include');
    expect(headers.get('X-Device-Id')).toBeTruthy();
    expect(headers.get('X-CSRF-Token')).toBeNull();
  });

  it('POST sends JSON body and the CSRF token from the memory store', async () => {
    sessionStore.set({ csrfToken: 'csrf-abc' });
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { ok: true } }));

    await api.post('/things', { amount: '10.00' });

    const { init, headers } = lastCall();
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"amount":"10.00"}');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(headers.get('X-CSRF-Token')).toBe('csrf-abc');
  });

  it('keeps the same device id across calls', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(200, { data: null })));
    await api.get('/a');
    const first = lastCall().headers.get('X-Device-Id');
    await api.get('/b');
    expect(lastCall().headers.get('X-Device-Id')).toBe(first);
  });

  it('throws a typed ApiError from the error envelope', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, {
        error: {
          code: 'CONFLICT_VERSION',
          message: 'Version mismatch',
          details: { server: { version: 3 } },
          requestId: 'req-1',
        },
      }),
    );

    const err = await api.get('/things/1').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    const apiErr = err as ApiError;
    expect(apiErr.code).toBe('CONFLICT_VERSION');
    expect(apiErr.status).toBe(409);
    expect(apiErr.details).toEqual({ server: { version: 3 } });
    expect(apiErr.requestId).toBe('req-1');
  });

  it('maps a non-envelope error page to a status-based ApiError', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('<html>Bad gateway</html>', { status: 502, headers: { 'X-Request-Id': 'r9' } }),
    );
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('INTERNAL');
    expect(err.status).toBe(502);
    expect(err.requestId).toBe('r9');
    expect(err.message).not.toContain('Bad gateway');
  });

  it('maps 401 without an envelope to UNAUTHENTICATED', async () => {
    fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }));
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('UNAUTHENTICATED');
  });

  it('throws ApiNetworkError when fetch itself fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(api.get('/x')).rejects.toBeInstanceOf(ApiNetworkError);
  });

  it('rejects a success response without a data field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { nope: true }));
    const err = (await api.get('/x').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe('INTERNAL');
  });
});
