import { t, type Locale, type MessageKey } from '@rezerwapp/shared';

/** Коды ошибок API (http/error.filter.ts) → сообщение клиенту. Нейтрально: blacklist = «нет мест» (BOOKING_FLOW, раздел 8). */
const BY_CODE: Record<string, MessageKey> = {
  SLOT_TAKEN: 'booking.error.slot_taken',
  SLOT_NOT_AVAILABLE: 'booking.error.slot_taken',
  NO_FREE_SLOTS: 'client.no_free_slots',
  OTP_INVALID: 'widget.error.otp',
  PENDING_LIMIT: 'widget.error.pending_limit',
  RATE_LIMITED: 'widget.error.rate',
  LEGAL_TEXTS_MISSING: 'widget.error.unavailable',
  PAYMENT_NOT_CONFIGURED: 'widget.error.unavailable',
  RESCHEDULE_TOO_LATE: 'booking.cancel.contact',
  RESCHEDULE_LIMIT: 'booking.cancel.contact',
  HOLD_EXPIRED: 'booking.hold.expired',
};

export function errorMessage(code: string | undefined, locale: Locale): string {
  const key = code ? BY_CODE[code] : undefined;
  return t(locale, key ?? 'widget.error.generic');
}
