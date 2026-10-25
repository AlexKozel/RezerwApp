import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addMonths, daySpan, gridBounds, monthGrid, occupancy, subtract, weekDays, weekStart, workingSpans } from '../src/lib/calendar';

const WAW = 'Europe/Warsaw';

describe('календарь недели и месяца', () => {
  test('неделя с понедельника, сетка месяца 6 недель, сдвиг месяца', () => {
    assert.equal(weekStart('2026-10-25'), '2026-10-19', 'воскресенье относится к неделе с понедельника');
    assert.equal(weekStart('2026-10-26'), '2026-10-26');
    assert.deepEqual([weekDays('2026-10-28')[0], weekDays('2026-10-28')[6]], ['2026-10-26', '2026-11-01']);
    const grid = monthGrid('2026-10-15');
    assert.deepEqual([grid.length, grid[0], grid[41]], [42, '2026-09-28', '2026-11-08']);
    assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
    assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
  });

  test('интервал в местном дне по настенным часам, включая переход на зимнее время', () => {
    // 10:00-11:30 по Варшаве летом = 08:00-09:30 UTC.
    assert.deepEqual(daySpan('2026-07-02', new Date('2026-07-02T08:00:00Z'), new Date('2026-07-02T09:30:00Z'), WAW), { start: 600, end: 690 });
    // День перехода (25 октября 2026): 10:00 уже зимнее, UTC+1.
    assert.deepEqual(daySpan('2026-10-25', new Date('2026-10-25T09:00:00Z'), new Date('2026-10-25T10:00:00Z'), WAW), { start: 600, end: 660 });
    // Выходной целиком = весь день; визит через полночь обрезается по дню.
    assert.deepEqual(daySpan('2026-07-02', new Date('2026-07-01T22:00:00Z'), new Date('2026-07-02T22:00:00Z'), WAW), { start: 0, end: 1440 });
    assert.deepEqual(daySpan('2026-07-02', new Date('2026-07-02T21:00:00Z'), new Date('2026-07-02T23:00:00Z'), WAW), { start: 1380, end: 1440 });
    assert.equal(daySpan('2026-07-03', new Date('2026-07-02T08:00:00Z'), new Date('2026-07-02T09:00:00Z'), WAW), null);
  });

  test('рабочее время, блокировки, загрузка и видимые часы', () => {
    const hours = [
      { weekday: 1, start: '09:00', end: '13:00' },
      { weekday: 1, start: '14:00', end: '18:00' },
    ];
    const monday = workingSpans('2026-10-26', hours);
    assert.deepEqual(monday, [{ start: 540, end: 780 }, { start: 840, end: 1080 }]);
    assert.deepEqual(workingSpans('2026-10-27', hours), []);
    assert.deepEqual(subtract(monday, [{ start: 600, end: 660 }]), [{ start: 540, end: 600 }, { start: 660, end: 780 }, { start: 840, end: 1080 }]);
    assert.equal(occupancy(monday, [{ start: 540, end: 660 }, { start: 780, end: 840 }]), 0.25, 'визит в перерыве не считается');
    assert.equal(occupancy([], [{ start: 540, end: 600 }]), null);
    assert.deepEqual(gridBounds([{ start: 545, end: 1070 }, { start: 600, end: 1100 }]), { start: 540, end: 1140 });
    assert.deepEqual(gridBounds([]), { start: 540, end: 1080 });
  });
});
