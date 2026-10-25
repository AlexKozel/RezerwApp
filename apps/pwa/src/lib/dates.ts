import { addDays, localDate, localDayRange, zonedToUtc } from '@rezerwapp/shared';

/** Сегодня в поясе Account (не телефона мастера: он может быть в отпуске в другом поясе). */
export function today(timeZone: string, now: Date = new Date()): string {
  return localDate(now, timeZone);
}

/** Границы местных суток для запроса записей: [from, to) в ISO. */
export function dayRange(day: string, timeZone: string): { from: string; to: string } {
  const { start, end } = localDayRange(day, timeZone);
  return { from: start.toISOString(), to: end.toISOString() };
}

/** Период с первого числа месяца дня day по первое число следующего (для отчёта «за месяц»). */
export function monthRange(day: string, timeZone: string): { from: string; to: string } {
  const first = `${day.slice(0, 7)}-01`;
  const [y, m] = [Number(day.slice(0, 4)), Number(day.slice(5, 7))];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from: localDayRange(first, timeZone).start.toISOString(), to: localDayRange(next, timeZone).start.toISOString() };
}

/** Время HH:MM в выбранный местный день → момент ISO (ручная запись на время вне сетки слотов). */
export function atLocalTime(day: string, hhmm: string, timeZone: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  return zonedToUtc(day, Number(m[1]) * 60 + Number(m[2]), timeZone)?.toISOString() ?? null;
}

export { addDays };
