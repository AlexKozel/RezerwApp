import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { computeSlots, type SlotQuery } from '../src/availability/slots';
import { addDays, localDate, localDayRange, offsetMinutes, weekdayOf, zonedToUtc } from '../src/availability/zoned-time';

const WAW = 'Europe/Warsaw';
const iso = (d: Date | null) => d?.toISOString() ?? null;
const hhmm = (h: number, m = 0) => h * 60 + m;

describe('часовой пояс Account (Europe/Warsaw)', () => {
  test('зимой UTC+1, летом UTC+2', () => {
    assert.equal(offsetMinutes(Date.parse('2030-01-15T12:00:00Z'), WAW), 60);
    assert.equal(offsetMinutes(Date.parse('2030-07-15T12:00:00Z'), WAW), 120);
    assert.equal(iso(zonedToUtc('2030-01-15', hhmm(9), WAW)), '2030-01-15T08:00:00.000Z');
    assert.equal(iso(zonedToUtc('2030-07-15', hhmm(9), WAW)), '2030-07-15T07:00:00.000Z');
  });

  test('весенний переход: 02:30 не существует, 03:00 уже летнее время', () => {
    // 2030-03-31: в 02:00 часы переводятся на 03:00.
    assert.equal(zonedToUtc('2030-03-31', hhmm(2, 30), WAW), null);
    assert.equal(iso(zonedToUtc('2030-03-31', hhmm(1, 59), WAW)), '2030-03-31T00:59:00.000Z');
    assert.equal(iso(zonedToUtc('2030-03-31', hhmm(3), WAW)), '2030-03-31T01:00:00.000Z');
  });

  test('осенний переход: неоднозначное 02:30 трактуется как зимнее (более позднее)', () => {
    // 2030-10-27: в 03:00 часы переводятся на 02:00, 02:30 бывает дважды.
    assert.equal(iso(zonedToUtc('2030-10-27', hhmm(2, 30), WAW)), '2030-10-27T01:30:00.000Z');
  });

  test('местные сутки в дни перехода длятся 23 и 25 часов', () => {
    const spring = localDayRange('2030-03-31', WAW);
    const autumn = localDayRange('2030-10-27', WAW);
    assert.equal((spring.end.getTime() - spring.start.getTime()) / 3_600_000, 23);
    assert.equal((autumn.end.getTime() - autumn.start.getTime()) / 3_600_000, 25);
    assert.equal(iso(spring.start), '2030-03-30T23:00:00.000Z');
  });

  test('даты и дни недели', () => {
    assert.equal(addDays('2030-12-31', 1), '2031-01-01');
    assert.equal(addDays('2030-03-01', -1), '2030-02-28');
    assert.equal(weekdayOf('2030-01-06'), 0); // воскресенье
    assert.equal(weekdayOf('2030-01-07'), 1);
    assert.equal(localDate(new Date('2030-01-15T23:30:00Z'), WAW), '2030-01-16');
  });
});

describe('computeSlots (D-043)', () => {
  // 2030-01-07 понедельник, 2030-01-08 вторник.
  const base: SlotQuery = {
    timeZone: WAW,
    fromDate: '2030-01-07',
    toDate: '2030-01-07',
    workingHours: [{ weekday: 1, start: hhmm(9), end: hhmm(12) }],
    busy: [],
    durationMin: 60,
    bufferMin: 0,
    stepMin: 30,
    now: new Date('2030-01-01T00:00:00Z'),
    minLeadMinutes: 120,
    horizonDays: 60,
  };
  const local = (slots: Date[]) => slots.map((s) => new Date(s.getTime() + 60 * 60_000).toISOString().slice(11, 16));

  test('шаг от начала рабочего интервала, визит целиком внутри интервала', () => {
    assert.deepEqual(local(computeSlots(base)), ['09:00', '09:30', '10:00', '10:30', '11:00']);
  });

  test('буфер может выходить за конец рабочего дня, но учитывается при пересечении с занятым', () => {
    assert.deepEqual(local(computeSlots({ ...base, bufferMin: 15 })), ['09:00', '09:30', '10:00', '10:30', '11:00']);
    const busy = [{ start: new Date('2030-01-07T09:00:00Z'), end: new Date('2030-01-07T10:00:00Z') }]; // 10:00-11:00 местного
    assert.deepEqual(local(computeSlots({ ...base, bufferMin: 15, busy })), ['11:00']);
  });

  test('занятое время исключает пересекающиеся слоты, граница [) не считается пересечением', () => {
    const busy = [{ start: new Date('2030-01-07T09:00:00Z'), end: new Date('2030-01-07T09:30:00Z') }]; // 10:00-10:30
    assert.deepEqual(local(computeSlots({ ...base, busy })), ['09:00', '10:30', '11:00']);
  });

  test('день недели без рабочих часов = выходной', () => {
    assert.deepEqual(computeSlots({ ...base, fromDate: '2030-01-08', toDate: '2030-01-08' }), []);
  });

  test('разовый выходной (блок на местные сутки) закрывает весь день', () => {
    const dayOff = localDayRange('2030-01-07', WAW);
    assert.deepEqual(computeSlots({ ...base, busy: [dayOff] }), []);
    assert.equal(computeSlots({ ...base, toDate: '2030-01-14', busy: [dayOff] }).length, 5); // следующий понедельник свободен
  });

  test('несколько интервалов в день (перерыв на обед)', () => {
    const workingHours = [
      { weekday: 1, start: hhmm(9), end: hhmm(11) },
      { weekday: 1, start: hhmm(12), end: hhmm(14) },
    ];
    assert.deepEqual(local(computeSlots({ ...base, workingHours, stepMin: 60 })), ['09:00', '10:00', '12:00', '13:00']);
  });

  test('не раньше чем за minLead и не дальше горизонта', () => {
    const now = new Date('2030-01-07T07:30:00Z'); // 08:30 местного
    assert.deepEqual(local(computeSlots({ ...base, now })), ['10:30', '11:00']);
    assert.deepEqual(computeSlots({ ...base, now: new Date('2029-10-01T00:00:00Z'), horizonDays: 60 }), []);
  });

  test('в день перехода на летнее время слоты считаются по местным часам', () => {
    // 2030-03-31 воскресенье: 09:00 местного уже UTC+2.
    const slots = computeSlots({
      ...base,
      fromDate: '2030-03-31',
      toDate: '2030-03-31',
      workingHours: [{ weekday: 0, start: hhmm(9), end: hhmm(10) }],
      now: new Date('2030-03-01T00:00:00Z'),
    });
    assert.deepEqual(slots.map((s) => s.toISOString()), ['2030-03-31T07:00:00.000Z']);
  });
});
