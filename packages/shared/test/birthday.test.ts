import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { formatBirthday, formatBirthdayValue, isValidBirthday, parseBirthday } from '../src';

describe('день рождения (D-065)', () => {
  test('только день и месяц, 29 февраля допустимо', () => {
    assert.deepEqual(parseBirthday('03-12'), { month: 3, day: 12 });
    assert.deepEqual(parseBirthday('02-29'), { month: 2, day: 29 });
    for (const bad of ['02-30', '04-31', '13-01', '00-10', '3-12', '03-12-1990', '']) assert.equal(parseBirthday(bad), null, bad);
    assert.equal(isValidBirthday(12, 31), true);
    assert.equal(formatBirthdayValue({ month: 3, day: 7 }), '03-07');
  });

  test('показ на языке интерфейса', () => {
    assert.equal(formatBirthday('03-12', 'pl'), '12 marca');
    assert.equal(formatBirthday('02-29', 'en'), '29 February');
  });
});
