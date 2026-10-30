import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseAmount } from '../src/lib/money';

describe('сумма из поля ввода (D-071)', () => {
  test('запятая или точка, до двух знаков, больше нуля', () => {
    assert.deepEqual(['45', '45,5', '45.50', ' 12 '].map(parseAmount), [45, 45.5, 45.5, 12]);
    assert.deepEqual(['0', '12.345', '-3', 'abc', ''].map(parseAmount), [null, null, null, null, null]);
  });
});
