import { formatDayLabel, formatMoney, formatTime, localDate, pickText, type MessageKey } from '@rezerwapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type CalendarBooking, type Me, type Staff } from '../api';
import { useT } from '../i18n';
import { addDays, dayRange, today } from '../lib/dates';
import { go } from '../router';

/** Заявки ищутся на этот срок вперёд (горизонт записи по умолчанию 60 дней, D-043). */
const REQUESTS_AHEAD_DAYS = 60;

type Action = 'confirmed' | 'rejected' | 'completed' | 'no_show' | 'cancelled_by_master';

/**
 * Календарь мастера: заявки на подтверждение (с проверкой оплаты BLIK по коду) и записи выбранного дня.
 * День и время в поясе Account. owner и assistant выбирают специалиста, staff видит только свои записи (D-047).
 */
export function Calendar({ me }: { me: Me }) {
  const { t, locale } = useT();
  const tz = me.timeZone;
  const [day, setDay] = useState(() => today(tz));
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffId, setStaffId] = useState<string>('');
  const [bookings, setBookings] = useState<CalendarBooking[] | null>(null);
  const [requests, setRequests] = useState<CalendarBooking[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (me.role !== 'staff') void api<Staff[]>('GET', '/staff').then((r) => setStaff((r.data ?? []).filter((s) => s.active)));
  }, [me.role]);

  const load = useCallback(async () => {
    const filter = staffId ? `&staffId=${staffId}` : '';
    const { from, to } = dayRange(day, tz);
    const ahead = dayRange(addDays(today(tz), REQUESTS_AHEAD_DAYS), tz);
    const [dayList, upcoming] = await Promise.all([
      api<CalendarBooking[]>('GET', `/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${filter}`),
      api<CalendarBooking[]>('GET', `/bookings?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(ahead.to)}${filter}`),
    ]);
    setBookings(dayList.data ?? []);
    setRequests((upcoming.data ?? []).filter((b) => b.status === 'pending'));
    setError(dayList.ok ? null : t(dayList.error === 'OFFLINE' ? 'pwa.offline' : 'pwa.error'));
  }, [day, staffId, tz, t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(b: CalendarBooking, to: Action) {
    if (to === 'cancelled_by_master' && !window.confirm(t('pwa.act.cancel_confirm'))) return;
    const r = await api('POST', `/bookings/${b.id}/transition`, { to, expectedVersion: b.version });
    if (!r.ok) setError(t(r.status === 403 ? 'pwa.forbidden' : 'pwa.error'));
    await load();
  }

  const card = (b: CalendarBooking, showDay: boolean) => (
    <div key={b.id} className="card booking">
      <div className="time">
        {showDay && <div className="muted">{formatDayLabel(localDate(new Date(b.startsAt), tz), locale)}</div>}
        {formatTime(new Date(b.startsAt), tz, locale)}
        <div className="muted">{formatTime(new Date(b.endsAt), tz, locale)}</div>
      </div>
      <div>
        <a href={`#/clients/${b.clientId}`}>{b.clientName}</a>
        <div>
          {pickText(b.serviceName, locale)}
          {pickText(b.variantName, locale) && <span className="muted"> · {pickText(b.variantName, locale)}</span>}
        </div>
        {!staffId && me.role !== 'staff' && <div className="muted">{b.staffName}</div>}
        <div className={`status ${b.status}`}>
          {t(`booking.status.${b.status}` as MessageKey)}
          {b.price !== null && ` · ${formatMoney(b.price, locale)} zł`}
        </div>
        {b.payment && <div className="status">{t(`pwa.pay.${b.payment.status}` as MessageKey)}</div>}
      </div>
      {b.status === 'pending' && (
        <div className="actions">
          {b.payment && b.payment.status === 'requested' && (
            <p className="muted" style={{ flexBasis: '100%', margin: 0 }}>
              {t('pwa.pay.check', { amount: formatMoney(b.payment.amount, locale), code: b.payment.code })}
            </p>
          )}
          <button type="button" className="primary" style={{ margin: 0 }} onClick={() => void act(b, 'confirmed')}>
            {t('pwa.act.confirm')}
          </button>
          <button type="button" className="secondary" onClick={() => void act(b, 'rejected')}>
            {t('pwa.act.reject')}
          </button>
        </div>
      )}
      {b.status === 'confirmed' && (
        <div className="actions">
          <button type="button" className="secondary" onClick={() => void act(b, 'completed')}>
            {t('pwa.act.complete')}
          </button>
          <button type="button" className="secondary" onClick={() => void act(b, 'no_show')}>
            {t('pwa.act.no_show')}
          </button>
          <button type="button" className="secondary" onClick={() => void act(b, 'cancelled_by_master')}>
            {t('pwa.act.cancel')}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <main>
      {staff.length > 1 && (
        <select aria-label={t('pwa.new.staff')} value={staffId} onChange={(e) => setStaffId(e.target.value)}>
          <option value="">{t('pwa.cal.all_staff')}</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </select>
      )}

      {requests.length > 0 && (
        <section>
          <h2>{t('pwa.cal.requests')}</h2>
          {requests.map((b) => card(b, true))}
        </section>
      )}

      <div className="daynav" style={{ marginTop: 16 }}>
        <button type="button" className="secondary" aria-label="‹" onClick={() => setDay(addDays(day, -1))}>
          ‹
        </button>
        <strong>{formatDayLabel(day, locale)}</strong>
        <button type="button" className="secondary" aria-label="›" onClick={() => setDay(addDays(day, 1))}>
          ›
        </button>
      </div>
      {day !== today(tz) && (
        <button type="button" className="chip" style={{ marginTop: 8 }} onClick={() => setDay(today(tz))}>
          {t('pwa.cal.today')}
        </button>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {bookings === null ? (
        <p className="muted">…</p>
      ) : bookings.filter((b) => b.status !== 'rescheduled').length === 0 ? (
        <p className="muted">{t('pwa.cal.empty')}</p>
      ) : (
        bookings.filter((b) => b.status !== 'rescheduled').map((b) => card(b, false))
      )}

      <a className="fab" href={`#/new/${day}`} onClick={() => go(`new/${day}`)}>
        + {t('pwa.cal.new')}
      </a>
    </main>
  );
}
