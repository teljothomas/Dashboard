import { ErrorEnvelope, type ErrorCode } from '@tradex/contracts';
import { getDeviceId, sessionStore } from './session';

export const API_BASE = '/api/v1';

/** Server answered with an error. `code` follows INTERFACES §1. */
export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly requestId: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    status: number,
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    this.requestId = requestId;
  }
}

/** No response at all (offline, DNS, connection reset). The offline layer retries these. */
export class ApiNetworkError extends Error {
  constructor(cause?: unknown) {
    super('Network request failed', { cause });
    this.name = 'ApiNetworkError';
  }
}

export interface ApiResult<T> {
  data: T;
  meta: { nextCursor?: string } | undefined;
}

export interface ApiRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function statusToCode(status: number): ErrorCode {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 400 && status < 500) return 'VALIDATION_FAILED';
  return 'INTERNAL';
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === '') {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Fetch wrapper for `/api/v1`: cookies included, JSON in/out, `X-Device-Id` on every request,
 * `X-CSRF-Token` on mutations, envelope parsed, typed errors thrown.
 */
export async function apiRequest<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<ApiResult<T>> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'X-Device-Id': getDeviceId(),
  };
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const csrf = sessionStore.get().csrfToken;
  if (!SAFE_METHODS.has(method) && csrf !== undefined) {
    headers['X-CSRF-Token'] = csrf;
  }

  let response: Response;
  try {
    const init: RequestInit = { method, headers, credentials: 'include' };
    if (options.body !== undefined) init.body = JSON.stringify(options.body);
    if (options.signal !== undefined) init.signal = options.signal;
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw new ApiNetworkError(err);
  }

  const json = await readJson(response);

  if (!response.ok) {
    const parsed = ErrorEnvelope.safeParse(json);
    if (parsed.success) {
      const { code, message, details, requestId } = parsed.data.error;
      throw new ApiError(code, message, response.status, details, requestId);
    }
    // Non-envelope failure (proxy error page, gateway timeout): keep the status, never trust the body.
    throw new ApiError(
      statusToCode(response.status),
      `Request failed with status ${response.status}`,
      response.status,
      undefined,
      response.headers.get('X-Request-Id') ?? undefined,
    );
  }

  if (!isRecord(json) || !('data' in json)) {
    throw new ApiError('INTERNAL', 'Malformed success response', response.status);
  }
  const meta = isRecord(json.meta) ? (json.meta as { nextCursor?: string }) : undefined;
  return { data: json.data as T, meta };
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => apiRequest<T>(path, signal ? { signal } : {}),
  post: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiRequest<T>(path, { method: 'PATCH', body }),
  delete: <T>(path: string) => apiRequest<T>(path, { method: 'DELETE' }),
};
