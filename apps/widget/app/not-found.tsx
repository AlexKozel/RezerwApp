import { t } from '@rezerwapp/shared';

export default function NotFound() {
  return (
    <main>
      <h1>{t('pl', 'widget.not_found')}</h1>
      <p className="muted" lang="en">
        {t('en', 'widget.not_found')}
      </p>
    </main>
  );
}
