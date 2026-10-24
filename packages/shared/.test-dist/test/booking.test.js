"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const booking_1 = require("../src/booking");
(0, node_test_1.describe)('машина статусов записи (BOOKING_FLOW.md)', () => {
    (0, node_test_1.test)('у каждого статуса задан список переходов', () => {
        for (const status of booking_1.BOOKING_STATUSES) {
            strict_1.default.ok(Array.isArray((0, booking_1.allowedTransitions)(status)), status);
        }
    });
    (0, node_test_1.test)('pending: подтвердить, отклонить, истечь, отмены; но не завершить', () => {
        for (const to of ['confirmed', 'rejected', 'expired', 'cancelled_by_client', 'cancelled_by_master']) {
            strict_1.default.equal((0, booking_1.canTransition)('pending', to), true, `pending → ${to}`);
        }
        for (const to of ['completed', 'no_show', 'rescheduled', 'pending']) {
            strict_1.default.equal((0, booking_1.canTransition)('pending', to), false, `pending → ${to}`);
        }
    });
    (0, node_test_1.test)('confirmed: завершить, неявка, отмены, перенос; не возвращается в pending', () => {
        for (const to of ['completed', 'no_show', 'cancelled_by_client', 'cancelled_by_master', 'rescheduled']) {
            strict_1.default.equal((0, booking_1.canTransition)('confirmed', to), true, `confirmed → ${to}`);
        }
        strict_1.default.equal((0, booking_1.canTransition)('confirmed', 'pending'), false);
        strict_1.default.equal((0, booking_1.canTransition)('confirmed', 'rejected'), false);
        strict_1.default.equal((0, booking_1.canTransition)('confirmed', 'expired'), false);
    });
    (0, node_test_1.test)('конечные статусы не имеют переходов', () => {
        const terminal = [
            'rejected', 'expired', 'cancelled_by_client', 'cancelled_by_master', 'completed', 'no_show', 'rescheduled',
        ];
        for (const status of terminal) {
            strict_1.default.equal((0, booking_1.isTerminal)(status), true, status);
            for (const to of booking_1.BOOKING_STATUSES)
                strict_1.default.equal((0, booking_1.canTransition)(status, to), false, `${status} → ${to}`);
        }
        strict_1.default.equal((0, booking_1.isTerminal)('pending'), false);
        strict_1.default.equal((0, booking_1.isTerminal)('confirmed'), false);
    });
    (0, node_test_1.test)('никакой статус не переходит сам в себя', () => {
        for (const status of booking_1.BOOKING_STATUSES)
            strict_1.default.equal((0, booking_1.canTransition)(status, status), false, status);
    });
    (0, node_test_1.test)('слот занимают только pending и confirmed (как ограничение в БД)', () => {
        for (const status of booking_1.BOOKING_STATUSES) {
            strict_1.default.equal((0, booking_1.holdsSlot)(status), status === 'pending' || status === 'confirmed', status);
        }
    });
});
(0, node_test_1.describe)('резервационная оплата: границы D-014', () => {
    (0, node_test_1.test)('процент: до 30% без предупреждения, 31-50% с предупреждением, выше 50% запрещено', () => {
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('percent', 30, 100), { ok: true, warning: false });
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('percent', 31, 100), { ok: true, warning: true });
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('percent', 50, 100), { ok: true, warning: true });
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('percent', 51, 100), { ok: false, reason: 'above_cap' });
    });
    (0, node_test_1.test)('фиксированная сумма пересчитывается в процент от цены', () => {
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('fixed', 30, 100), { ok: true, warning: false });
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('fixed', 40, 100), { ok: true, warning: true });
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('fixed', 50, 100), { ok: true, warning: true });
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('fixed', 60, 100), { ok: false, reason: 'above_cap' });
    });
    (0, node_test_1.test)('фиксированная оплата для бесплатной услуги недопустима', () => {
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('fixed', 10, 0), { ok: false, reason: 'above_cap' });
    });
    (0, node_test_1.test)('режим none допускает только нулевое значение', () => {
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('none', 0, 100), { ok: true, warning: false });
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('none', 10, 100), { ok: false, reason: 'invalid' });
    });
    (0, node_test_1.test)('отрицательные и нечисловые значения отклоняются', () => {
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('fixed', -1, 100), { ok: false, reason: 'invalid' });
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('percent', Number.NaN, 100), { ok: false, reason: 'invalid' });
        strict_1.default.deepEqual((0, booking_1.checkDeposit)('fixed', 10, Number.POSITIVE_INFINITY), { ok: false, reason: 'invalid' });
    });
});
