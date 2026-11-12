import { ApiError, ApiNetworkError } from '../../lib/api';
import { t, type MessageKey } from '../../lib/i18n';

/**
 * Plain-language message for a failed auth request. Login failures stay generic on purpose
 * (the server never says whether the username or the password was wrong).
 */
export function authErrorMessage(err: unknown): string {
  if (err instanceof ApiNetworkError) return t('error.network');
  if (err instanceof ApiError) {
    if (err.code === 'RATE_LIMITED') return t('error.rateLimited');
    if (err.code === 'UNAUTHENTICATED') return t('login.error.invalid');
    // Policy messages ("Password is too short") are written for people by the server.
    if (err.code === 'VALIDATION_FAILED' && err.message !== '') return err.message;
  }
  return t('error.generic');
}

const RESET_REASON: Partial<Record<string, MessageKey>> = {
  RESET_CODE_INVALID: 'reset.error.invalid',
};

export function resetErrorMessage(err: unknown): string {
  if (err instanceof ApiError && typeof err.details?.reason === 'string') {
    const key = RESET_REASON[err.details.reason];
    if (key !== undefined) return t(key);
  }
  return authErrorMessage(err);
}

/** Only same-origin absolute paths, never the login pages themselves (open-redirect guard). */
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (value.startsWith('/\\') || value === '/login' || value.startsWith('/login?')) return '/';
  return value;
}
