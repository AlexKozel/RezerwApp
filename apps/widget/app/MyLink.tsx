'use client';

import { t, type Locale } from '@rezerwapp/shared';
import { useEffect, useState } from 'react';
import { loadSaved } from '../lib/my-bookings';

/** Ссылка на «Мои записи» (D-069): показывается, только если на этом телефоне уже есть сохранённые записи. */
export function MyLink({ locale }: { locale: Locale }) {
  const [count, setCount] = useState(0);
  useEffect(() => setCount(loadSaved().length), []);
  if (count === 0) return null;
  return (
    <p className="my-link">
      <a href={`/moje?lang=${locale}`}>
        {t(locale, 'widget.my_title')} ({count})
      </a>
    </p>
  );
}
