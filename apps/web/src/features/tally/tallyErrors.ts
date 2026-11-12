import { ApiError, ApiNetworkError } from '../../lib/api';
import { t } from '../../lib/i18n';

/** Plain-language text for a failed Tally request. */
export function tallyErrorMessage(err: unknown): string {
  if (err instanceof ApiNetworkError) return t('error.network');
  if (err instanceof ApiError) {
    if (err.code === 'RATE_LIMITED') return t('error.rateLimited');
    if (err.code === 'NOT_FOUND') return t('tally.error.notFound');
    if (err.code === 'FORBIDDEN') return t('tally.error.forbidden');
    if (err.code === 'VALIDATION_FAILED' && err.message !== '') return err.message;
  }
  return t('error.generic');
}
