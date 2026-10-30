'use client';

import { t, type Locale } from '@rezerwapp/shared';
import { useEffect, useState } from 'react';
import { googleCalendarUrl } from '../lib/my-bookings';

/**
 * «Добавить в календарь» (D-069): Google по ссылке-шаблону, Apple и Outlook файлом .ics от API.
 * В описании события ссылка управления записью: из календаря можно перенести или отменить.
 */
export function AddToCalendar({ token, title, startsAt, endsAt, locale }: { token: string; title: string; startsAt: string; endsAt: string; locale: Locale }) {
  // Адрес сайта известен только в браузере (тот же код рендерится на сервере).
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const manage = `${origin}/b/${token}?lang=${locale}`;
  return (
    <div className="calendar-add">
      <div className="muted">{t(locale, 'widget.calendar_add')}</div>
      <div className="row">
        <a className="chip" href={googleCalendarUrl(title, startsAt, endsAt, manage)} target="_blank" rel="noopener">
          Google
        </a>
        <a className="chip" href={`/api/public/bookings/${token}/ics?lang=${locale}`}>
          Apple / Outlook
        </a>
      </div>
    </div>
  );
}
