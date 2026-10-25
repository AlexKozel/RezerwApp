import { addDays, localDayRange, offsetMinutes, weekdayOf } from '@rezerwapp/shared';
import type { ApiInterval } from './hours';

/** Отрезок местного дня в минутах от полуночи по настенным часам: [start, end), end до 1440. */
export interface Span {
  start: number;
  end: number;
}

const DAY_MIN = 24 * 60;

/** Статусы, которые показываются в сетке и считаются в загрузке: визит был или будет. */
export const VISIBLE_STATUSES = ['pending', 'confirmed', 'completed', 'no_show'] as const;

export function isVisible(status: string): boolean {
  return (VISIBLE_STATUSES as readonly string[]).includes(status);
}

/** Понедельник недели дня (неделя в Польше начинается с понедельника). */
export function weekStart(day: string): string {
  return addDays(day, -((weekdayOf(day) + 6) % 7));
}

export function weekDays(day: string): string[] {
  const monday = weekStart(day);
  return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** 6 недель с понедельника перед первым числом месяца: сетка месяца всегда одной высоты. */
export function monthGrid(day: string): string[] {
  const monday = weekStart(`${day.slice(0, 7)}-01`);
  return Array.from({ length: 42 }, (_, i) => addDays(monday, i));
}

/** Тот же день месяца со сдвигом на n месяцев; 31 января + 1 = 28/29 февраля. */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = [Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1 + n, Number(day.slice(8, 10))];
  const first = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

function wallMinutes(ms: number, timeZone: string): number {
  const local = ms + offsetMinutes(ms, timeZone) * 60_000;
  return Math.round((((local % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
}

/** Часть интервала [from, to), попавшая в местный день, по настенным часам; null, если не попала. */
export function daySpan(day: string, from: Date, to: Date, timeZone: string): Span | null {
  const { start, end } = localDayRange(day, timeZone);
  const s = Math.max(from.getTime(), start.getTime());
  const e = Math.min(to.getTime(), end.getTime());
  if (s >= e) return null;
  return { start: wallMinutes(s, timeZone), end: e >= end.getTime() ? DAY_MIN : wallMinutes(e, timeZone) };
}

function toMinutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

/** Рабочие отрезки дня по недельному графику. */
export function workingSpans(day: string, hours: readonly ApiInterval[]): Span[] {
  const weekday = weekdayOf(day);
  return hours
    .filter((h) => h.weekday === weekday)
    .map((h) => ({ start: toMinutes(h.start), end: toMinutes(h.end) }))
    .sort((a, b) => a.start - b.start);
}

/** Отрезки spans без отрезков cuts (рабочее время минус блокировки и выходные). */
export function subtract(spans: readonly Span[], cuts: readonly Span[]): Span[] {
  let result = [...spans];
  for (const cut of cuts) {
    result = result.flatMap((s) => {
      if (cut.end <= s.start || cut.start >= s.end) return [s];
      const parts: Span[] = [];
      if (cut.start > s.start) parts.push({ start: s.start, end: cut.start });
      if (cut.end < s.end) parts.push({ start: cut.end, end: s.end });
      return parts;
    });
  }
  return result;
}

/** Видимые часы сетки недели: от раннего начала до позднего конца, по целым часам; без данных 9-18. */
export function gridBounds(spans: readonly Span[]): Span {
  if (spans.length === 0) return { start: 9 * 60, end: 18 * 60 };
  const start = Math.min(...spans.map((s) => s.start));
  const end = Math.max(...spans.map((s) => s.end));
  return { start: Math.floor(start / 60) * 60, end: Math.min(DAY_MIN, Math.ceil(end / 60) * 60) };
}

function total(spans: readonly Span[]): number {
  return spans.reduce((sum, s) => sum + (s.end - s.start), 0);
}

/** Доля рабочего времени, занятая визитами (0..1); null, если рабочего времени нет (выходной). */
export function occupancy(working: readonly Span[], busy: readonly Span[]): number | null {
  const available = total(working);
  if (available === 0) return null;
  const free = total(subtract(working, busy));
  return (available - free) / available;
}

export function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
