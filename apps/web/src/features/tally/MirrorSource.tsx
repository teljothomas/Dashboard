import { Badge } from '../../components/ui/form';
import { formatDateTime } from '../../lib/datetime';
import { t } from '../../lib/i18n';

/** Every mirror row says where it came from (TALLY) and how fresh it is. */
export function MirrorSource({ asOf }: { asOf: string }) {
  return (
    <p className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
      <Badge tone="slate">{t('tally.data.source')}</Badge>
      {t('tally.data.asOf', { when: formatDateTime(asOf) })}
    </p>
  );
}
