import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BOOKING_STATUSES,
  allowedTransitions,
  canTransition,
  checkDeposit,
  holdsSlot,
  isTerminal,
  type BookingStatus,
} from '../src/booking';

describe('машина статусов записи (BOOKING_FLOW.md)', () => {
  test('у каждого статуса задан список переходов', () => {
    for (const status of BOOKING_STATUSES) {
      assert.ok(Array.isArray(allowedTransitions(status)), status);
    }
  });

  test('pending: подтвердить, отклонить, истечь, отмены; но не завершить', () => {
    for (const to of ['confirmed', 'rejected', 'expired', 'cancelled_by_client', 'cancelled_by_master'] as const) {
      assert.equal(canTransition('pending', to), true, `pending → ${to}`);
    }
    for (const to of ['completed', 'no_show', 'rescheduled', 'pending'] as const) {
      assert.equal(canTransition('pending', to), false, `pending → ${to}`);
    }
  });

  test('confirmed: завершить, неявка, отмены, перенос; не возвращается в pending', () => {
    for (const to of ['completed', 'no_show', 'cancelled_by_client', 'cancelled_by_master', 'rescheduled'] as const) {
      assert.equal(canTransition('confirmed', to), true, `confirmed → ${to}`);
    }
    assert.equal(canTransition('confirmed', 'pending'), false);
    assert.equal(canTransition('confirmed', 'rejected'), false);
    assert.equal(canTransition('confirmed', 'expired'), false);
  });

  test('конечные статусы не имеют переходов', () => {
    const terminal: BookingStatus[] = [
      'rejected', 'expired', 'cancelled_by_client', 'cancelled_by_master', 'completed', 'no_show', 'rescheduled',
    ];
    for (const status of terminal) {
      assert.equal(isTerminal(status), true, status);
      for (const to of BOOKING_STATUSES) assert.equal(canTransition(status, to), false, `${status} → ${to}`);
    }
    assert.equal(isTerminal('pending'), false);
    assert.equal(isTerminal('confirmed'), false);
  });

  test('никакой статус не переходит сам в себя', () => {
    for (const status of BOOKING_STATUSES) assert.equal(canTransition(status, status), false, status);
  });

  test('слот занимают только pending и confirmed (как ограничение в БД)', () => {
    for (const status of BOOKING_STATUSES) {
      assert.equal(holdsSlot(status), status === 'pending' || status === 'confirmed', status);
    }
  });
});

describe('резервационная оплата: границы D-014', () => {
  test('процент: до 30% без предупреждения, 31-50% с предупреждением, выше 50% запрещено', () => {
    assert.deepEqual(checkDeposit('percent', 30, 100), { ok: true, warning: false });
    assert.deepEqual(checkDeposit('percent', 31, 100), { ok: true, warning: true });
    assert.deepEqual(checkDeposit('percent', 50, 100), { ok: true, warning: true });
    assert.deepEqual(checkDeposit('percent', 51, 100), { ok: false, reason: 'above_cap' });
  });

  test('фиксированная сумма пересчитывается в процент от цены', () => {
    assert.deepEqual(checkDeposit('fixed', 30, 100), { ok: true, warning: false });
    assert.deepEqual(checkDeposit('fixed', 40, 100), { ok: true, warning: true });
    assert.deepEqual(checkDeposit('fixed', 50, 100), { ok: true, warning: true });
    assert.deepEqual(checkDeposit('fixed', 60, 100), { ok: false, reason: 'above_cap' });
  });

  test('фиксированная оплата для бесплатной услуги недопустима', () => {
    assert.deepEqual(checkDeposit('fixed', 10, 0), { ok: false, reason: 'above_cap' });
  });

  test('режим none допускает только нулевое значение', () => {
    assert.deepEqual(checkDeposit('none', 0, 100), { ok: true, warning: false });
    assert.deepEqual(checkDeposit('none', 10, 100), { ok: false, reason: 'invalid' });
  });

  test('отрицательные и нечисловые значения отклоняются', () => {
    assert.deepEqual(checkDeposit('fixed', -1, 100), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkDeposit('percent', Number.NaN, 100), { ok: false, reason: 'invalid' });
    assert.deepEqual(checkDeposit('fixed', 10, Number.POSITIVE_INFINITY), { ok: false, reason: 'invalid' });
  });
});
