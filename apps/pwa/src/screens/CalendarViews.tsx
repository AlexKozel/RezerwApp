import { formatTime, localDate, pickText } from '@rezerwapp/shared';
import { useEffect, useState } from 'react';
import { api, type CalendarBooking } from '../api';
import { useT } from '../i18n';
import {
  daySpan,
  formatMinutes,
  gridBounds,
  isVisible,
  monthGrid,
  occupancy,
  subtract,
  weekDays,
  workingSpans,
  type Span,
} from '../lib/calendar';
import { dayRange, today } from '../lib/dates';
import type { ApiInterval } from '../lib/hours';
import { go } from '../router';

export interface ScopeStaff {
  id: string;
  name: string;
}

interface Schedule {
  bookings: CalendarBooking[];
  hours: Record<string, ApiInterval[]>;
  blocks: Record<string, Array<{ start: Date; end: Date }>>;
}

/** Цвета специалистов в общей сетке (по порядку в списке). */
const STAFF_COLORS = ['#2563eb', '#db2777', '#059669', '#d97706', '#7c3aed', '#0891b2'];
const HOUR_PX = 44;

/**
 * Записи, недельный график и блокировки специалистов за период. Перерисовка только при смене периода или состава:
 * зависимости загрузки стабильны (см. LocaleProvider), иначе экран снова ушёл бы в бесконечные запросы.
 */
function useSchedule(scope: ScopeStaff[], staffFilter: string, days: string[], timeZone: string): Schedule | null {
  const [data, setData] = useState<Schedule | null>(null);
  const from = days[0]!;
  const last = days[days.length - 1]!;
  const ids = scope.map((s) => s.id).join(',');
  useEffect(() => {
    let cancelled = false;
    setData(null);
    const range = { from: dayRange(from, timeZone).from, to: dayRange(last, timeZone).to };
    const q = `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
    const staffIds = ids ? ids.split(',') : [];
    void Promise.all([
      api<CalendarBooking[]>('GET', `/bookings?${q}${staffFilter ? `&staffId=${staffFilter}` : ''}`),
      ...staffIds.map((id) => api<ApiInterval[]>('GET', `/staff/${id}/working-hours`)),
      ...staffIds.map((id) => api<Array<{ start: string; end: string }>>('GET', `/staff/${id}/time-blocks?${q}`)),
    ]).then(([bookings, ...rest]) => {
      if (cancelled) return;
      const hours: Schedule['hours'] = {};
      const blocks: Schedule['blocks'] = {};
      staffIds.forEach((id, i) => {
        hours[id] = (rest[i]?.data as ApiInterval[] | undefined) ?? [];
        blocks[id] = ((rest[staffIds.length + i]?.data as Array<{ start: string; end: string }> | undefined) ?? []).map((b) => ({
          start: new Date(b.start),
          end: new Date(b.end),
        }));
      });
      setData({ bookings: (bookings.data ?? []).filter((b) => isVisible(b.status)), hours, blocks });
    });
    return () => {
      cancelled = true;
    };
  }, [from, last, ids, staffFilter, timeZone]);
  return data;
}

function blockSpans(day: string, blocks: Array<{ start: Date; end: Date }>, timeZone: string): Span[] {
  return blocks.map((b) => daySpan(day, b.start, b.end, timeZone)).filter((s): s is Span => s !== null);
}

function bookingSpan(day: string, b: CalendarBooking, timeZone: string): Span | null {
  return daySpan(day, new Date(b.startsAt), new Date(b.endsAt), timeZone);
}

function weekdayShort(day: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00Z`));
}

/**
 * Неделя: сетка часов на 7 дней. Белое: рабочее (свободное) время, серое: вне графика, штриховка: блокировка
 * или выходной. При «все специалисты» у дня дорожка на каждого, записи окрашены по специалисту.
 */
export function WeekView({
  scope,
  staffFilter,
  day,
  timeZone,
  onOpenDay,
}: {
  scope: ScopeStaff[];
  staffFilter: string;
  day: string;
  timeZone: string;
  onOpenDay: (day: string) => void;
}) {
  const { t, locale } = useT();
  const days = weekDays(day);
  const data = useSchedule(scope, staffFilter, days, timeZone);
  const lanes = scope;
  const colored = lanes.length > 1;

  if (!data) return <p className="muted">…</p>;

  const all: Span[] = [];
  for (const d of days) {
    for (const s of lanes) all.push(...workingSpans(d, data.hours[s.id] ?? []));
    for (const b of data.bookings) {
      const span = bookingSpan(d, b, timeZone);
      if (span) all.push(span);
    }
  }
  const bounds = gridBounds(all);
  const span = bounds.end - bounds.start;
  const height = (span / 60) * HOUR_PX;
  const pct = (m: number) => `${((Math.min(Math.max(m, bounds.start), bounds.end) - bounds.start) / span) * 100}%`;
  const len = (s: Span) => `${((Math.min(s.end, bounds.end) - Math.max(s.start, bounds.start)) / span) * 100}%`;
  const hours = Array.from({ length: span / 60 }, (_, i) => bounds.start + i * 60);
  const now = today(timeZone);

  function addAt(e: React.MouseEvent<HTMLDivElement>, d: string, staffId: string, free: Span[]) {
    const rect = e.currentTarget.getBoundingClientRect();
    const minute = bounds.start + Math.floor(((e.clientY - rect.top) / rect.height) * span / 15) * 15;
    if (!free.some((f) => minute >= f.start && minute < f.end)) return;
    go(`new/${d}/${formatMinutes(minute)}/${staffId}`);
  }

  return (
    <div className="week">
      <div className="week-head">
        <span />
        {days.map((d) => (
          <button key={d} type="button" className={d === now ? 'today' : undefined} onClick={() => onOpenDay(d)}>
            <span>{weekdayShort(d, locale)}</span>
            <strong>{Number(d.slice(8))}</strong>
          </button>
        ))}
      </div>
      <div className="week-body" style={{ height }}>
        <div className="week-hours">
          {hours.map((h) => (
            <span key={h} style={{ top: pct(h) }}>
              {formatMinutes(h)}
            </span>
          ))}
        </div>
        {days.map((d) => (
          <div key={d} className="week-day" style={{ backgroundSize: `100% ${HOUR_PX}px` }}>
            {lanes.map((s, i) => {
              const working = workingSpans(d, data.hours[s.id] ?? []);
              const blocked = blockSpans(d, data.blocks[s.id] ?? [], timeZone);
              const free = subtract(working, blocked);
              const visits = data.bookings.filter((b) => b.staffId === s.id);
              return (
                <div
                  key={s.id}
                  className="lane"
                  style={{ left: `${(i / lanes.length) * 100}%`, width: `${100 / lanes.length}%` }}
                  onClick={(e) => addAt(e, d, s.id, free)}
                >
                  {free.map((f) => (
                    <div key={`f${f.start}`} className="free" style={{ top: pct(f.start), height: len(f) }} />
                  ))}
                  {blocked.map((b) => (
                    <div key={`b${b.start}`} className="blocked" style={{ top: pct(b.start), height: len(b) }} />
                  ))}
                  {visits.map((b) => {
                    const bs = bookingSpan(d, b, timeZone);
                    if (!bs) return null;
                    const color = colored ? STAFF_COLORS[i % STAFF_COLORS.length] : undefined;
                    return (
                      <button
                        key={b.id}
                        type="button"
                        className={`visit ${b.status}`}
                        style={{ top: pct(bs.start), height: len(bs), ...(color && { ['--visit' as string]: color }) }}
                        title={`${formatTime(new Date(b.startsAt), timeZone, locale)} ${b.clientName} · ${pickText(b.serviceName, locale)}${colored ? ` · ${b.staffName}` : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDay(d);
                        }}
                      >
                        <span>{formatTime(new Date(b.startsAt), timeZone, locale)}</span>
                        <span>{b.clientName}</span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="legend">
        <span>
          <i className="free" /> {t('pwa.cal.legend.free')}
        </span>
        <span>
          <i className="off" /> {t('pwa.cal.legend.off')}
        </span>
        <span>
          <i className="blocked" /> {t('pwa.cal.legend.blocked')}
        </span>
        <span>
          <i className="pending" /> {t('pwa.cal.legend.pending')}
        </span>
        {colored &&
          lanes.map((s, i) => (
            <span key={s.id}>
              <i style={{ background: STAFF_COLORS[i % STAFF_COLORS.length] }} /> {s.name}
            </span>
          ))}
      </div>
      <p className="muted">{t('pwa.cal.week.hint')}</p>
    </div>
  );
}

/** Месяц: число визитов в дне, точка при заявке, полоска загрузки рабочего времени; выходные серые. */
export function MonthView({
  scope,
  staffFilter,
  day,
  timeZone,
  onOpenDay,
}: {
  scope: ScopeStaff[];
  staffFilter: string;
  day: string;
  timeZone: string;
  onOpenDay: (day: string) => void;
}) {
  const { t, locale } = useT();
  const days = monthGrid(day);
  const data = useSchedule(scope, staffFilter, days, timeZone);
  const month = day.slice(0, 7);
  const now = today(timeZone);

  if (!data) return <p className="muted">…</p>;

  const byDay = new Map<string, CalendarBooking[]>();
  for (const b of data.bookings) {
    const d = localDate(new Date(b.startsAt), timeZone);
    byDay.set(d, [...(byDay.get(d) ?? []), b]);
  }

  return (
    <div className="month">
      <div className="month-grid">
        {days.slice(0, 7).map((d) => (
          <span key={d} className="month-wd">
            {weekdayShort(d, locale)}
          </span>
        ))}
        {days.map((d) => {
          const visits = byDay.get(d) ?? [];
          let load: number | null = null;
          let working = 0;
          let busy = 0;
          for (const s of scope) {
            const w = subtract(workingSpans(d, data.hours[s.id] ?? []), blockSpans(d, data.blocks[s.id] ?? [], timeZone));
            const o = occupancy(
              w,
              visits.filter((b) => b.staffId === s.id).map((b) => bookingSpan(d, b, timeZone)).filter((x): x is Span => x !== null),
            );
            if (o === null) continue;
            const minutes = w.reduce((sum, x) => sum + x.end - x.start, 0);
            working += minutes;
            busy += o * minutes;
          }
          if (working > 0) load = busy / working;
          const percent = Math.round((load ?? 0) * 100);
          const classes = ['month-day', d.slice(0, 7) !== month && 'other', load === null && 'off', d === now && 'today'].filter(Boolean).join(' ');
          return (
            <button
              key={d}
              type="button"
              className={classes}
              aria-label={t('pwa.cal.month.cell', { day: d, count: visits.length, percent })}
              onClick={() => onOpenDay(d)}
            >
              <span className="num">{Number(d.slice(8))}</span>
              {visits.length > 0 && <strong>{visits.length}</strong>}
              {visits.some((b) => b.status === 'pending') && <i className="dot" />}
              {load !== null && (
                <span className="load">
                  <span style={{ width: `${percent}%` }} />
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="muted">{t('pwa.cal.month.hint')}</p>
    </div>
  );
}
