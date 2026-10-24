/** Статусы и переходы записи. Источник правды: BOOKING_FLOW.md, разделы 1-2. */
export const BOOKING_STATUSES = [
  'pending',
  'confirmed',
  'rejected',
  'expired',
  'cancelled_by_client',
  'cancelled_by_master',
  'completed',
  'no_show',
  'rescheduled',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

/** Статусы, занимающие слот (ограничение bookings_no_overlap в БД). */
export const SLOT_HOLDING_STATUSES: readonly BookingStatus[] = ['pending', 'confirmed'];

const TRANSITIONS: Readonly<Record<BookingStatus, readonly BookingStatus[]>> = {
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

export function allowedTransitions(from: BookingStatus): readonly BookingStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: BookingStatus, to: BookingStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function isTerminal(status: BookingStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function holdsSlot(status: BookingStatus): boolean {
  return SLOT_HOLDING_STATUSES.includes(status);
}

export type PrepaymentMethod = 'none' | 'manual_blik' | 'provider_link';
export type DepositMode = 'none' | 'fixed' | 'percent';

/** Потолок процента резервационной оплаты (D-014); дублируется ограничением в БД. */
export const DEPOSIT_PERCENT_HARD_CAP = 50;
/** Выше этого процента мастер получает предупреждение (D-014). */
export const DEPOSIT_PERCENT_WARN_THRESHOLD = 30;

export type DepositCheck = { ok: true; warning: boolean } | { ok: false; reason: 'above_cap' | 'invalid' };

/** Проверка размера оплаты относительно цены услуги. Границы утверждаются юристом (L-31). */
export function checkDeposit(mode: DepositMode, value: number, servicePrice: number): DepositCheck {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(servicePrice) || servicePrice < 0) {
    return { ok: false, reason: 'invalid' };
  }
  if (mode === 'none') return value === 0 ? { ok: true, warning: false } : { ok: false, reason: 'invalid' };
  const percent = mode === 'percent' ? value : servicePrice === 0 ? Infinity : (value / servicePrice) * 100;
  if (percent > DEPOSIT_PERCENT_HARD_CAP) return { ok: false, reason: 'above_cap' };
  return { ok: true, warning: percent > DEPOSIT_PERCENT_WARN_THRESHOLD };
}
