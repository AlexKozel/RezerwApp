'use client';

import { t, type Locale, type MessageKey } from '@rezerwapp/shared';
import { useEffect, useMemo, useState } from 'react';
import { clientCall, type ManagedBooking } from '../../../lib/api';
import { errorMessage } from '../../../lib/errors';
import { addDays, formatDayLabel, formatMoney, formatTime, formatWhen, groupByDay, localDay, pickText } from '../../../lib/format';
import { bookAgainUrl, forget, remember, toSaved } from '../../../lib/my-bookings';
import { AddToCalendar } from '../../AddToCalendar';
import { MyLink } from '../../MyLink';

const DAYS_AHEAD = 14;

/**
 * Управление записью клиентом (D-051, BOOKING_FLOW.md, раздел 5): просмотр, отмена (с предупреждением о поздней
 * отмене), перенос до дедлайна; после дедлайна вместо переноса «связаться со специалистом» (D-012).
 */
export function ManageBooking({ token, booking, locale }: { token: string; booking: ManagedBooking; locale: Locale }) {
  const tz = booking.timeZone;
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [day, setDay] = useState<string | null>(null);

  // D-069: открытая ссылка записи попадает в «Мои записи» на этом телефоне.
  useEffect(() => remember(toSaved(token, booking)), [token, booking]);

  const days = useMemo(() => groupByDay(slots ?? [], tz), [slots, tz]);
  const activeDay = day ?? days[0]?.day ?? null;
  const daySlots = days.find((d) => d.day === activeDay)?.slots ?? [];

  async function cancel() {
    const warning = booking.lateCancel ? `\n\n${t(locale, 'widget.cancel_late')}` : '';
    if (!window.confirm(t(locale, 'widget.cancel_confirm') + warning)) return;
    setBusy(true);
    const r = await clientCall('POST', `/public/bookings/${token}/cancel`);
    setBusy(false);
    if (r.ok) setDone('widget.cancelled');
    else setError(errorMessage(r.error, locale));
  }

  async function loadSlots() {
    setError(null);
    const from = localDay(new Date(), tz);
    const r = await clientCall<{ slots: string[] }>('GET', `/public/bookings/${token}/slots?from=${from}&to=${addDays(from, DAYS_AHEAD - 1)}`);
    if (r.ok) setSlots(r.data?.slots ?? []);
    else setError(errorMessage(r.error, locale));
  }

  async function reschedule(startsAt: string) {
    setBusy(true);
    const r = await clientCall<{ token: string }>('POST', `/public/bookings/${token}/reschedule`, { startsAt });
    setBusy(false);
    if (r.ok && r.data) {
      // Старая ссылка больше не нужна в списке: новая запись сохранится на своей странице.
      forget(token);
      window.location.assign(`/b/${r.data.token}?lang=${locale}`);
    }
    else setError(errorMessage(r.error, locale));
  }

  const fee = booking.bookingFee;
  const status = done === 'widget.cancelled' ? 'cancelled_by_client' : booking.status;
  return (
    <section>
      <h1>{pickText(booking.service, locale)}</h1>
      <p className="muted">{booking.staffName}</p>
      <div className="card">
        <div>
          <strong>{t(locale, 'widget.when')}:</strong> {formatWhen(new Date(booking.startsAt), tz, locale)}
        </div>
        <div>{t(locale, `booking.status.${status}` as MessageKey)}</div>
        {booking.price !== null && booking.discountPercent !== null && (
          <div>{t(locale, 'widget.your_price', { price: formatMoney(booking.price, locale), percent: booking.discountPercent })}</div>
        )}
      </div>

      {fee && fee.blikPhone && status === 'pending' && (
        <div className="card fee">
          <div className="muted">{t(locale, 'booking.fee.label')}</div>
          <p>{t(locale, 'booking.fee.instruction', { amount: formatMoney(fee.amount, locale), phone: fee.blikPhone, code: fee.code })}</p>
          <strong>{fee.code}</strong>
        </div>
      )}

      {done && (
        <p className="notice ok" role="status">
          {t(locale, done)}
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}

      {!done && (booking.status === 'pending' || booking.status === 'confirmed') && (
        <>
          <p className="muted">{t(locale, 'booking.cancel.free_until', { hours: booking.policy.freeCancelHours })}</p>

          {booking.canReschedule && slots === null && (
            <button type="button" className="secondary" disabled={busy} onClick={() => void loadSlots()}>
              {t(locale, 'booking.reschedule')}
            </button>
          )}
          {slots !== null && (
            <>
              <h2>{t(locale, 'widget.reschedule_choose')}</h2>
              {days.length === 0 ? (
                <p className="muted">{t(locale, 'widget.no_slots')}</p>
              ) : (
                <>
                  <div className="days" role="group">
                    {days.map((d) => (
                      <button key={d.day} type="button" className="chip" aria-pressed={d.day === activeDay} onClick={() => setDay(d.day)}>
                        {formatDayLabel(d.day, locale)}
                      </button>
                    ))}
                  </div>
                  <div className="slots" role="group">
                    {daySlots.map((s) => (
                      <button key={s.toISOString()} type="button" className="chip" disabled={busy} onClick={() => void reschedule(s.toISOString())}>
                        {formatTime(s, tz, locale)}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {booking.contactMaster && <p className="notice warn">{t(locale, 'booking.cancel.contact')}</p>}

          {booking.canCancel && (
            <>
              {booking.lateCancel && <p className="notice warn">{t(locale, 'widget.cancel_late')}</p>}
              <button type="button" className="primary" disabled={busy} onClick={() => void cancel()}>
                {t(locale, 'widget.cancel')}
              </button>
            </>
          )}
        </>
      )}

      {!done && (booking.status === 'pending' || booking.status === 'confirmed') && (
        <AddToCalendar
          token={token}
          title={`${pickText(booking.service, locale)} · ${booking.staffName}`}
          startsAt={booking.startsAt}
          endsAt={booking.endsAt}
          locale={locale}
        />
      )}
      {(done || !(booking.status === 'pending' || booking.status === 'confirmed')) && (
        <a className="secondary" style={{ display: 'block', textAlign: 'center', textDecoration: 'none', marginTop: 12 }} href={bookAgainUrl({ slug: booking.staffSlug, serviceId: booking.serviceId, variantId: booking.variantId }, locale)}>
          {t(locale, 'widget.book_again')}
        </a>
      )}

      <p>
        <a href={`/${booking.staffSlug}?lang=${locale}`}>{booking.staffName}</a>
      </p>
      <MyLink locale={locale} />
    </section>
  );
}
