import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { atLocalTime, dayRange, monthRange, today } from '../src/lib/dates';
import { invalidRows, toIntervals, toRows } from '../src/lib/hours';

const WAW = 'Europe/Warsaw';

describe('даты в поясе Account', () => {
  test('сегодня и сутки по Варшаве, включая день перехода на зимнее время', () => {
    assert.equal(today(WAW, new Date('2030-07-01T22:30:00Z')), '2030-07-02');
    assert.deepEqual(dayRange('2030-07-02', WAW), { from: '2030-07-01T22:00:00.000Z', to: '2030-07-02T22:00:00.000Z' });
    const dst = dayRange('2030-10-27', WAW);
    assert.equal((Date.parse(dst.to) - Date.parse(dst.from)) / 3_600_000, 25);
  });

  test('месяц и время вне сетки', () => {
    assert.deepEqual(monthRange('2030-12-15', WAW), { from: '2030-11-30T23:00:00.000Z', to: '2030-12-31T23:00:00.000Z' });
    assert.equal(atLocalTime('2030-07-02', '09:30', WAW), '2030-07-02T07:30:00.000Z');
    assert.equal(atLocalTime('2030-07-02', '9:30', WAW), null);
    assert.equal(atLocalTime('2030-03-31', '02:30', WAW), null, 'несуществующее время перехода на летнее');
  });
});

describe('редактор недели', () => {
  test('неделя с понедельника; день без интервалов выходной; несколько интервалов помечаются', () => {
    const rows = toRows([
      { weekday: 1, start: '09:00', end: '13:00' },
      { weekday: 1, start: '14:00', end: '18:00' },
      { weekday: 6, start: '10:00', end: '15:00' },
    ]);
    assert.deepEqual(rows.map((r) => r.weekday), [1, 2, 3, 4, 5, 6, 0]);
    assert.deepEqual(rows[0], { weekday: 1, open: true, start: '09:00', end: '18:00', merged: true });
    assert.equal(rows[1]!.open, false);
    assert.deepEqual(toIntervals(rows), [
      { weekday: 1, start: '09:00', end: '18:00' },
      { weekday: 6, start: '10:00', end: '15:00' },
    ]);
  });

  test('конец раньше начала отмечается', () => {
    const rows = toRows([{ weekday: 2, start: '18:00', end: '09:00' }]);
    assert.deepEqual(invalidRows(rows), [2]);
  });
});
