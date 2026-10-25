import { Logger } from '@nestjs/common';
import type { BookingStatus } from '@rezerwapp/shared';

/** События, о которых нужно сообщить клиенту или мастеру (BOOKING_FLOW.md, раздел 6). Только id, без данных. */
export type BookingNotification =
  | { type: 'booking.created'; accountId: string; bookingId: string; status: BookingStatus }
  | { type: 'booking.status_changed'; accountId: string; bookingId: string; to: BookingStatus }
  | { type: 'booking.expired'; accountId: string; bookingId: string }
  | { type: 'booking.master_reminder'; accountId: string; bookingId: string; staffId: string }
  | { type: 'booking.client_reminder'; accountId: string; bookingId: string }
  | { type: 'booking.cancelled_by_client'; accountId: string; bookingId: string; late: boolean }
  | { type: 'booking.rescheduled'; accountId: string; bookingId: string; fromBookingId: string }
  | { type: 'account.sms_quota'; accountId: string; month: string; percent: number }
  /** Утреннее напоминание мастерам о днях рождения клиентов (D-065), date: местная дата Account. */
  | { type: 'account.birthdays'; accountId: string; date: string };

/** Ключ события: одно и то же событие доставляется получателю один раз (notification_log, очередь). */
export function dedupeKey(event: BookingNotification): string {
  switch (event.type) {
    case 'booking.status_changed':
      return `${event.type}:${event.bookingId}:${event.to}`;
    case 'account.sms_quota':
      return `${event.type}:${event.month}`;
    case 'account.birthdays':
      return `${event.type}:${event.date}`;
    default:
      return `${event.type}:${event.bookingId}`;
  }
}

/**
 * Постановка уведомления. Вызывается после коммита: ошибка доставки не откатывает смену статуса записи,
 * вызывающая сторона только логирует сбой. Реализация по умолчанию ставит событие в очередь (QueueNotifier).
 */
export interface Notifier {
  notify(event: BookingNotification): Promise<void>;
}

const notifyLogger = new Logger('Notifier');

/** Ставит уведомление; сбой (например, Redis недоступен) логируется и не ломает уже выполненное действие. */
export async function notifySafely(notifier: Notifier | undefined, event: BookingNotification): Promise<void> {
  if (!notifier) return;
  try {
    await notifier.notify(event);
  } catch (error) {
    notifyLogger.error(`notify ${dedupeKey(event)}: ${(error as Error).message}`);
  }
}

/** Только лог (тип и ключ, без персональных данных): для процессов без Redis и для отладки. */
export class LogNotifier implements Notifier {
  private readonly logger = new Logger('Notifier');

  async notify(event: BookingNotification): Promise<void> {
    this.logger.log(dedupeKey(event));
  }
}
