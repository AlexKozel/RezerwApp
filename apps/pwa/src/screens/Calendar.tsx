import { formatDayLabel, formatMoney, formatTime, localDate, pickText, type MessageKey } from '@rezerwapp/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, type CalendarBooking, type ClientBirthday, type Me, type Staff } from '../api';
import { useT } from '../i18n';
import { addMonths, weekDays } from '../lib/calendar';
import { addDays, dayRange, today } from '../lib/dates';
import { go } from '../router';
import { MonthView, WeekView, type ScopeStaff } from './CalendarViews';

type View = 'day' | 'week' | 'month';
const VIEW_KEY = 'rezerwapp.calview';

function savedView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'day' || v === 'week' || v === 'month') return v;
  } catch {
    // хранилище недоступно: вид по умолчанию
  }
  return 'day';
}

/** Заявки ищутся на этот срок вперёд (горизонт записи по умолчанию 60 дней, D-043). */
const REQUESTS_AHEAD_DAYS = 60;

type Action = 'confirmed' | 'rejected' | 'completed' | 'no_show' | 'cancelled_by_master';

/**
 * Календарь мастера: заявки на подтверждение (с проверкой оплаты BLIK по коду) и записи выбранного дня.
 * День и время в поясе Account. owner и assistant выбирают специалиста, staff видит только свои записи (D-047).
 * Вид: день (записи с действиями), неделя (сетка со свободным временем) или месяц (загрузка по дням), D-063.
 */
export function Calendar({ me }: { me: Me }) {
  const { t, locale } = useT();
  const tz = me.timeZone;
  const [day, setDay] = useState(() => today(tz));
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffId, setStaffId] = useState<string>('');
  const [bookings, setBookings] = useState<CalendarBooking[] | null>(null);
  const [requests, setRequests] = useState<CalendarBooking[]>([]);
  const [birthdays, setBirthdays] = useState<ClientBirthday[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [view, setViewState] = useState<View>(savedView);

  const setView = (v: View) => {
    setViewState(v);
    try {
      localStorage.setItem(VIEW_KEY, v);
    } catch {
      // не критично
    }
  };
  const openDay = (d: string) => {
    setDay(d);
    setView('day');
  };
  const scope: ScopeStaff[] =
    me.role === 'staff'
      ? me.staffId
        ? [{ id: me.staffId, name: '' }]
        : []
      : staff.filter((s) => !staffId || s.id === staffId).map((s) => ({ id: s.id, name: s.displayName }));
  const step = (n: number) => setDay(view === 'day' ? addDays(day, n) : view === 'week' ? addDays(day, 7 * n) : addMonths(day, n));
  const week = weekDays(day);
  const label =
    view === 'day'
      ? formatDayLabel(day, locale)
      : view === 'week'
        ? `${formatDayLabel(week[0]!, locale)} – ${formatDayLabel(week[6]!, locale)}`
        : new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
  const showsToday = view === 'day' ? day === today(tz) : view === 'week' ? week.includes(today(tz)) : day.slice(0, 7) === today(tz).slice(0, 7);

  useEffect(() => {
    if (me.role !== 'staff') void api<Staff[]>('GET', '/staff').then((r) => setStaff((r.data ?? []).filter((s) => s.active)));
  }, [me.role]);

  const load = useCallback(async () => {
    const filter = staffId ? `&staffId=${staffId}` : '';
    const { from, to } = dayRange(day, tz);
    const ahead = dayRange(addDays(today(tz), REQUESTS_AHEAD_DAYS), tz);
    const [dayList, upcoming, born] = await Promise.all([
      api<CalendarBooking[]>('GET', `/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${filter}`),
      api<CalendarBooking[]>('GET', `/bookings?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(ahead.to)}${filter}`),
      api<ClientBirthday[]>('GET', `/clients/birthdays?from=${day}`),
    ]);
    setBookings(dayList.data ?? []);
    setBirthdays(born.data ?? []);
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

      <div className="views" role="group">
        {(['day', 'week', 'month'] as const).map((v) => (
          <button key={v} type="button" className="chip" aria-pressed={view === v} onClick={() => setView(v)}>
            {t(`pwa.cal.view.${v}`)}
          </button>
        ))}
      </div>

      <div className="daynav" style={{ marginTop: 12 }}>
        <button type="button" className="secondary" aria-label="‹" onClick={() => step(-1)}>
          ‹
        </button>
        <strong>{label}</strong>
        <button type="button" className="secondary" aria-label="›" onClick={() => step(1)}>
          ›
        </button>
      </div>
      {!showsToday && (
        <button type="button" className="chip" style={{ marginTop: 8 }} onClick={() => setDay(today(tz))}>
          {t('pwa.cal.today')}
        </button>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {view === 'day' && birthdays.length > 0 && (
        <p className="notice birthdays">
          🎂 {t('pwa.client.birthday')}:{' '}
          {birthdays.map((b, i) => (
            <span key={b.id}>
              {i > 0 && ', '}
              <a href={`#/clients/${b.id}`}>{b.name}</a>
            </span>
          ))}
        </p>
      )}
      {view === 'week' ? (
        <WeekView scope={scope} staffFilter={staffId} day={day} timeZone={tz} onOpenDay={openDay} />
      ) : view === 'month' ? (
        <MonthView scope={scope} staffFilter={staffId} day={day} timeZone={tz} onOpenDay={openDay} />
      ) : bookings === null ? (
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
