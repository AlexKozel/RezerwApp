import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { normalizePhone } from '../src/phone';

describe('normalizePhone', () => {
  test('польские номера без кода страны получают +48', () => {
    assert.equal(normalizePhone('500 100 200'), '+48500100200');
    assert.equal(normalizePhone('500-100-200'), '+48500100200');
    assert.equal(normalizePhone('(500) 100.200'), '+48500100200');
  });

  test('номер с кодом страны в разных записях сводится к одному виду', () => {
    const expected = '+48500100200';
    for (const input of ['+48 500 100 200', '0048500100200', '48500100200', ' +48500100200 ']) {
      assert.equal(normalizePhone(input), expected, input);
    }
  });

  test('международные номера принимаются только с + или 00', () => {
    assert.equal(normalizePhone('+380 50 123 4567'), '+380501234567');
    assert.equal(normalizePhone('00380501234567'), '+380501234567');
    assert.equal(normalizePhone('380501234567'), null);
  });

  test('мусор и слишком короткие или длинные номера отклоняются', () => {
    for (const input of ['', '   ', 'abc', '12345', '+48', '+0123456789', '+1234567890123456', '5001002']) {
      assert.equal(normalizePhone(input), null, input);
    }
  });
});
