'use client';

import { t, type Locale, type MessageKey } from '@rezerwapp/shared';
import { useEffect, useState } from 'react';
import { clientCall, type ManagedBooking } from '../../lib/api';
import { formatWhen, pickText } from '../../lib/format';
import { bookAgainUrl, loadSaved, masters, split, storeSaved, toSaved, upsert, type SavedBooking } from '../../lib/my-bookings';
import { AddToCalendar } from '../AddToCalendar';

/** Сколько записей обновлять с сервера при открытии (самые новые): лимит запросов ссылок 120 в час с IP. */
const REFRESH_LIMIT = 15;

/**
 * Список записей клиента на этом телефоне (D-069): ближайшие с управлением и календарём, мастера с «записаться
 * снова», прошлые. Статусы обновляются по ссылкам записей; перенесённая запись заменяется новой.
 */
export function MyBookings({ locale }: { locale: Locale }) {
  const [list, setList] = useState<SavedBooking[] | null>(null);

  useEffect(() => {
    const saved = loadSaved();
    setList(saved);
    let cancelled = false;
    void (async () => {
      let current = saved;
      for (const b of saved.slice(0, REFRESH_LIMIT)) {
        const r = await clientCall<ManagedBooking>('GET', `/public/bookings/${b.token}`);
        if (cancelled) return;
        if (r.status === 404) {
          current = current.filter((x) => x.token !== b.token);
          continue;
        }
        if (!r.ok || !r.data) continue;
        let token = b.token;
        let data = r.data;
        // Перенос: у старой ссылки есть новая запись; в списке остаётся только новая.
        if (data.rescheduledToToken) {
          const next = await clientCall<ManagedBooking>('GET', `/public/bookings/${data.rescheduledToToken}`);
          if (!next.ok || !next.data) continue;
          token = data.rescheduledToToken;
          data = next.data;
        }
        current = upsert(current, toSaved(token, data), b.token);
      }
      storeSaved(current);
      setList(current);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const remove = (token: string) => {
    const next = (list ?? []).filter((b) => b.token !== token);
    storeSaved(next);
    setList(next);
  };
  const clear = () => {
    storeSaved([]);
    setList([]);
  };

  if (list === null) return <p className="muted">…</p>;
  const { upcoming, past } = split(list, new Date());
  const title = (b: SavedBooking) => [pickText(b.service, locale), pickText(b.variant, locale)].filter(Boolean).join(' · ');

  return (
    <section>
      <h1>{t(locale, 'widget.my_title')}</h1>
      {list.length === 0 && <p className="muted">{t(locale, 'widget.my_empty')}</p>}

      {upcoming.length > 0 && <h2>{t(locale, 'widget.my_upcoming')}</h2>}
      {upcoming.map((b) => (
        <div key={b.token} className="card">
          <strong>{formatWhen(new Date(b.startsAt), b.timeZone, locale)}</strong>
          <div>
            {title(b)} · {b.staffName}
          </div>
          <div className="muted">{t(locale, `booking.status.${b.status}` as MessageKey)}</div>
          <a className="primary" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: 8 }} href={`/b/${b.token}?lang=${locale}`}>
            {t(locale, 'widget.manage')}
          </a>
          <AddToCalendar token={b.token} title={`${title(b)} · ${b.staffName}`} startsAt={b.startsAt} endsAt={b.endsAt} locale={locale} />
        </div>
      ))}

      {list.length > 0 && <h2>{t(locale, 'widget.my_masters')}</h2>}
      {masters(list).map((b) => (
        <div key={b.slug} className="card">
          <a href={`/${b.slug}?lang=${locale}`}>
            <strong>{b.staffName}</strong>
          </a>
          <div className="muted">{title(b)}</div>
          <a className="secondary" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: 8 }} href={bookAgainUrl(b, locale)}>
            {t(locale, 'widget.book_again')}
          </a>
        </div>
      ))}

      {past.length > 0 && <h2>{t(locale, 'widget.my_past')}</h2>}
      {past.map((b) => (
        <div key={b.token} className="card">
          <div>{formatWhen(new Date(b.startsAt), b.timeZone, locale)}</div>
          <div className="muted">
            {title(b)} · {b.staffName} · {t(locale, `booking.status.${b.status}` as MessageKey)}
          </div>
          <button type="button" className="link" onClick={() => remove(b.token)}>
            {t(locale, 'widget.my_remove')}
          </button>
        </div>
      ))}

      {list.length > 0 && (
        <>
          <p className="muted">{t(locale, 'widget.my_hint')}</p>
          <button type="button" className="link" onClick={clear}>
            {t(locale, 'widget.my_clear')}
          </button>
        </>
      )}
    </section>
  );
}
