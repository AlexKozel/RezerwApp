'use client';

import { t, type Locale, type MessageKey } from '@rezerwapp/shared';
import { useState } from 'react';
import { clientCall, type WaitlistView } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { formatDayLabel, formatTime, formatWhen, pickText } from '../../../lib/format';

/** Клиент видит своё место в очереди: специалист, услуга, период; при предложении ссылку на запись; выход. */
export function WaitlistEntry({ token, entry, locale }: { token: string; entry: WaitlistView; locale: Locale }) {
  const [status, setStatus] = useState(entry.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tz = entry.timeZone;

  async function leave() {
    setBusy(true);
    const r = await clientCall('POST', `/public/waitlist/${token}/cancel`);
    setBusy(false);
    if (r.ok) setStatus('cancelled');
    else setError(errorMessage(r.error, locale));
  }

  const service = [pickText(entry.serviceName, locale), pickText(entry.variantName, locale)].filter(Boolean).join(' · ');
  const offerDay = entry.offer ? new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(entry.offer.startsAt)) : null;
  return (
    <section>
      <h1>{t(locale, 'widget.waitlist_title')}</h1>
      <p>
        <strong>{entry.staffName}</strong> · {service}
      </p>
      <p className="muted">
        {formatDayLabel(entry.dateFrom, locale)} – {formatDayLabel(entry.dateTo, locale)} · {t(locale, `widget.part_${entry.partOfDay}` as MessageKey)}
      </p>

      {status === 'waiting' && entry.offer && offerDay && (
        <div className="notice ok">
          <p style={{ marginTop: 0 }}>
            {t(locale, 'widget.waitlist_offer', {
              date: formatWhen(new Date(entry.offer.startsAt), tz, locale),
              until: formatTime(new Date(entry.offer.expiresAt), tz, locale),
            })}
          </p>
          <a className="primary" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }} href={`/${entry.slug}?service=${entry.serviceId}&variant=${entry.variantId}&date=${offerDay}&lang=${locale}`}>
            {t(locale, 'widget.waitlist_book')}
          </a>
        </div>
      )}
      {status === 'waiting' && <p>{t(locale, 'widget.waitlist_done')}</p>}
      {status === 'booked' && <p className="notice ok">{t(locale, 'widget.waitlist_status_booked')}</p>}
      {status === 'expired' && <p className="notice">{t(locale, 'widget.waitlist_status_expired')}</p>}
      {status === 'cancelled' && <p className="notice">{t(locale, 'widget.waitlist_left')}</p>}

      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {status === 'waiting' && (
        <button type="button" className="secondary" disabled={busy} onClick={() => void leave()}>
          {t(locale, 'widget.waitlist_leave')}
        </button>
      )}
    </section>
  );
}
