import { offsetMinutes } from '../../src/availability/zoned-time';

const QUARTER = 15 * 60_000;

/**
 * Ближайшее время на сетке 15 минут не раньше now + minAheadMs, при котором визит до maxVisitMin минут целиком
 * помещается в местный день (с 01:00 до полуночи). Тесты с «сейчас + N часов» иначе падали вечером: визит
 * переходил через полночь, за конец рабочего дня 00:00-24:00, и слот правильно не предлагался.
 */
export function slotWithinDay(minAheadMs: number, timeZone = 'Europe/Warsaw', maxVisitMin = 120): Date {
  let t = Math.ceil((Date.now() + minAheadMs) / QUARTER) * QUARTER;
  for (;;) {
    const local = new Date(t + offsetMinutes(t, timeZone) * 60_000);
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    if (minutes >= 60 && minutes + maxVisitMin <= 24 * 60) return new Date(t);
    t += QUARTER;
  }
}
