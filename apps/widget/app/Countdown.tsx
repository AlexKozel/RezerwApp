'use client';

import { t, type Locale } from '@rezerwapp/shared';
import { useEffect, useState } from 'react';
import { formatCountdown } from '../lib/format';

/** Видимый таймер hold (D-017): клиент знает, сколько времени у мастера на подтверждение и у него на оплату. */
export function Countdown({ until, locale }: { until: string; locale: Locale }) {
  const end = Date.parse(until);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <p className="muted" aria-live="off">
      {t(locale, 'widget.hold_left', { time: formatCountdown(end - now) })}
    </p>
  );
}
