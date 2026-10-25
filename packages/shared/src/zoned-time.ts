/**
 * Перевод «локальная дата + время суток в часовом поясе Account» в момент UTC и обратно через Intl,
 * без библиотек дат. Переходы на летнее и зимнее время:
 * - несуществующее время (весной 02:00-03:00 в Europe/Warsaw) → null;
 * - неоднозначное время (осенью 02:00-03:00 дважды) → более поздний из двух моментов.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Локальное «настенное» время момента utcMs, закодированное как миллисекунды UTC (для арифметики). */
function wallClock(utcMs: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
}

/** Смещение пояса в минутах для момента utcMs (Europe/Warsaw: 60 зимой, 120 летом). */
export function offsetMinutes(utcMs: number, timeZone: string): number {
  const floored = Math.floor(utcMs / MINUTE) * MINUTE;
  return (wallClock(floored, timeZone) - floored) / MINUTE;
}

/** Момент UTC для локальной даты YYYY-MM-DD и минут от полуночи; null, если такого времени нет (DST). */
export function zonedToUtc(date: string, minutesOfDay: number, timeZone: string): Date | null {
  const wall = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + minutesOfDay * MINUTE;
  // Два кандидата: со смещением «до» и «после» возможного перехода. Подходит тот, что даёт то же настенное время.
  const candidates = [wall - offsetMinutes(wall - DAY / 2, timeZone) * MINUTE, wall - offsetMinutes(wall + DAY / 2, timeZone) * MINUTE];
  const valid = candidates.filter((utc) => wallClock(utc, timeZone) === wall);
  if (valid.length === 0) return null;
  return new Date(Math.max(...valid));
}

/** Локальная дата YYYY-MM-DD момента в поясе. */
export function localDate(at: Date, timeZone: string): string {
  return new Date(wallClock(at.getTime(), timeZone)).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
}

/** 0 = воскресенье … 6 = суббота (как working_hours.weekday). */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Интервал [начало, конец) локальных суток в UTC: для выходного дня целиком (D-043). */
export function localDayRange(date: string, timeZone: string): { start: Date; end: Date } {
  // Полночь существует во всех поясах Европы; на случай поясов с переходом в 00:00 берём первую валидную минуту.
  const at = (d: string): Date => {
    for (let m = 0; m < 120; m += 1) {
      const t = zonedToUtc(d, m, timeZone);
      if (t) return t;
    }
    throw new Error(`no valid local time at the start of ${d} in ${timeZone}`);
  };
  return { start: at(date), end: at(addDays(date, 1)) };
}
