import { t, type MessageKey } from '../../lib/i18n';

/** Stand-in for sections built in later phases. */
export function PlaceholderPage({ titleKey }: { titleKey: MessageKey }) {
  return (
    <section>
      <h1 className="text-xl font-semibold">{t(titleKey)}</h1>
      <p className="mt-2 text-slate-600">{t('page.placeholder.body')}</p>
    </section>
  );
}
