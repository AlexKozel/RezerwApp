import { Logger } from '@nestjs/common';

/** События, о которых нужно сообщить клиенту или мастеру (BOOKING_FLOW.md, раздел 6). */
export type BookingNotification =
  | { type: 'booking.expired'; accountId: string; bookingId: string }
  | { type: 'booking.master_reminder'; accountId: string; bookingId: string; staffId: string };

/**
 * Отправка уведомлений. Каналы (push, мессенджеры, email, SMS, D-035) появятся в модуле notifications;
 * до тех пор события только журналируются. Ошибка отправки не должна откатывать смену статуса записи,
 * поэтому уведомление идёт после коммита и сбой лишь логируется вызывающей стороной.
 */
export interface Notifier {
  notify(event: BookingNotification): Promise<void>;
}

/** Временная реализация: пишет в лог тип и id, без персональных данных (ARCHITECTURE.md, раздел 9). */
export class LogNotifier implements Notifier {
  private readonly logger = new Logger('Notifier');

  async notify(event: BookingNotification): Promise<void> {
    this.logger.log(`${event.type} booking=${event.bookingId}`);
  }
}
