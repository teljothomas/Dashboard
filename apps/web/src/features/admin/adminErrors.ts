import { ApiError, ApiNetworkError } from '../../lib/api';
import { t, type MessageKey } from '../../lib/i18n';

const REASON_MESSAGE: Record<string, MessageKey> = {
  OWNER_ONLY: 'admin.error.OWNER_ONLY',
  SELF_MODIFICATION: 'admin.error.SELF_MODIFICATION',
  LAST_OWNER: 'admin.error.LAST_OWNER',
  SYSTEM_ROLE_IMMUTABLE: 'admin.error.SYSTEM_ROLE_IMMUTABLE',
  USERNAME_TAKEN: 'admin.error.USERNAME_TAKEN',
  ROLE_CODE_TAKEN: 'admin.error.ROLE_CODE_TAKEN',
  UNKNOWN_ROLE: 'admin.error.UNKNOWN_ROLE',
  UNKNOWN_DIVISION: 'admin.error.UNKNOWN_DIVISION',
  UNKNOWN_PERMISSION: 'admin.error.UNKNOWN_PERMISSION',
  DUPLICATE_PERMISSION: 'admin.error.DUPLICATE_PERMISSION',
  USER_NOT_ACTIVE: 'admin.error.USER_NOT_ACTIVE',
};

/** Plain-language text for a failed administration request, keyed on `details.reason` first. */
export function adminErrorMessage(err: unknown): string {
  if (err instanceof ApiNetworkError) return t('error.network');
  if (err instanceof ApiError) {
    const reason = err.details?.reason;
    if (typeof reason === 'string') {
      const key = REASON_MESSAGE[reason];
      if (key !== undefined) return t(key);
    }
    if (err.code === 'RATE_LIMITED') return t('error.rateLimited');
    // A division-limited grant also answers 404 (out of scope reads as not found).
    if (err.code === 'NOT_FOUND') return t('admin.error.notFound');
    if (err.code === 'FORBIDDEN') return t('admin.error.forbidden');
    if (err.code === 'VALIDATION_FAILED' && err.message !== '') return err.message;
  }
  return t('error.generic');
}
