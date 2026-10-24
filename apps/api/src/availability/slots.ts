import { addDays, weekdayOf, zonedToUtc } from './zoned-time';

export interface WorkingInterval {
  /** 0 = воскресенье … 6 = суббота. */
  weekday: number;
  /** Минуты от полуночи по местному времени, [start, end). */
  start: number;
  end: number;
}

export interface Interval {
  start: Date;
  end: Date;
}

export interface SlotQuery {
  timeZone: string;
  /** Локальные даты включительно, YYYY-MM-DD. */
  fromDate: string;
  toDate: string;
  workingHours: readonly WorkingInterval[];
  /** Занятое время: записи (их slot, уже с буфером) и блоки времени, включая выходные дни. */
  busy: readonly Interval[];
  durationMin: number;
  bufferMin: number;
  stepMin: number;
  now: Date;
  minLeadMinutes: number;
  horizonDays: number;
}

const MINUTE = 60_000;

/**
 * Свободные начала визитов (D-043). Слот подходит, если:
 * - визит [start, start + длительность) целиком внутри рабочего интервала дня (буфер может выйти за конец);
 * - [start, start + длительность + буфер) не пересекается с занятым временем (как bookings_no_overlap в БД);
 * - start не раньше now + minLead и не позже now + horizon.
 * Шаг отсчитывается от начала каждого рабочего интервала. День без рабочих интервалов = выходной.
 */
export function computeSlots(q: SlotQuery): Date[] {
  const earliest = q.now.getTime() + q.minLeadMinutes * MINUTE;
  const latest = q.now.getTime() + q.horizonDays * 24 * 60 * MINUTE;
  const busy = [...q.busy].sort((a, b) => a.start.getTime() - b.start.getTime());
  const result: Date[] = [];

  for (let date = q.fromDate; date <= q.toDate; date = addDays(date, 1)) {
    const intervals = q.workingHours
      .filter((w) => w.weekday === weekdayOf(date))
      .sort((a, b) => a.start - b.start);
    for (const w of intervals) {
      const open = zonedToUtc(date, w.start, q.timeZone);
      const close = zonedToUtc(date, w.end, q.timeZone);
      if (!open || !close) continue; // граница интервала попала в пропущенный час перехода на летнее время

      for (let t = open.getTime(); t + q.durationMin * MINUTE <= close.getTime(); t += q.stepMin * MINUTE) {
        if (t < earliest || t > latest) continue;
        const end = t + (q.durationMin + q.bufferMin) * MINUTE;
        const blocked = busy.some((b) => b.start.getTime() < end && t < b.end.getTime());
        if (!blocked) result.push(new Date(t));
      }
    }
  }
  return result;
}
