"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEPOSIT_PERCENT_WARN_THRESHOLD = exports.DEPOSIT_PERCENT_HARD_CAP = exports.SLOT_HOLDING_STATUSES = exports.BOOKING_STATUSES = void 0;
exports.allowedTransitions = allowedTransitions;
exports.canTransition = canTransition;
exports.isTerminal = isTerminal;
exports.holdsSlot = holdsSlot;
exports.checkDeposit = checkDeposit;
/** Статусы и переходы записи. Источник правды: BOOKING_FLOW.md, разделы 1-2. */
exports.BOOKING_STATUSES = [
    'pending',
    'confirmed',
    'rejected',
    'expired',
    'cancelled_by_client',
    'cancelled_by_master',
    'completed',
    'no_show',
    'rescheduled',
];
/** Статусы, занимающие слот (ограничение bookings_no_overlap в БД). */
exports.SLOT_HOLDING_STATUSES = ['pending', 'confirmed'];
const TRANSITIONS = {
    pending: ['confirmed', 'rejected', 'expired', 'cancelled_by_client', 'cancelled_by_master'],
    confirmed: ['completed', 'no_show', 'cancelled_by_client', 'cancelled_by_master', 'rescheduled'],
    rejected: [],
    expired: [],
    cancelled_by_client: [],
    cancelled_by_master: [],
    completed: [],
    no_show: [],
    rescheduled: [],
};
function allowedTransitions(from) {
    return TRANSITIONS[from];
}
function canTransition(from, to) {
    return TRANSITIONS[from].includes(to);
}
function isTerminal(status) {
    return TRANSITIONS[status].length === 0;
}
function holdsSlot(status) {
    return exports.SLOT_HOLDING_STATUSES.includes(status);
}
/** Потолок процента резервационной оплаты (D-014); дублируется ограничением в БД. */
exports.DEPOSIT_PERCENT_HARD_CAP = 50;
/** Выше этого процента мастер получает предупреждение (D-014). */
exports.DEPOSIT_PERCENT_WARN_THRESHOLD = 30;
/** Проверка размера оплаты относительно цены услуги. Границы утверждаются юристом (L-31). */
function checkDeposit(mode, value, servicePrice) {
    if (!Number.isFinite(value) || value < 0 || !Number.isFinite(servicePrice) || servicePrice < 0) {
        return { ok: false, reason: 'invalid' };
    }
    if (mode === 'none')
        return value === 0 ? { ok: true, warning: false } : { ok: false, reason: 'invalid' };
    const percent = mode === 'percent' ? value : servicePrice === 0 ? Infinity : (value / servicePrice) * 100;
    if (percent > exports.DEPOSIT_PERCENT_HARD_CAP)
        return { ok: false, reason: 'above_cap' };
    return { ok: true, warning: percent > exports.DEPOSIT_PERCENT_WARN_THRESHOLD };
}
