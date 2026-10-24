import { Logger } from '@nestjs/common';
import type { BookingsService } from '../bookings/bookings.service';
import type { Db } from '../db/db';
import type { Notifier } from './notifier';

/** Через сколько минут без ответа мастеру уходит напоминание о заявке (D-017). */
export const MASTER_REMINDER_AFTER_MIN = 30;

export interface MaintenanceResult {
  accounts: number;
  expired: number;
  reminded: number;
}

/**
 * Периодическое обслуживание записей (D-017, D-049): истечение hold и напоминание мастеру.
 * Account с заявками pending находит функция jobs_accounts_with_pending (миграция 0006), дальше каждый
 * Account обрабатывается под своим RLS. Сбой в одном Account не останавливает остальные.
 */
export class MaintenanceJobs {
  private readonly logger = new Logger('MaintenanceJobs');

  constructor(
    private readonly db: Db,
    private readonly bookings: BookingsService,
    private readonly notifier: Notifier,
  ) {}

  async run(): Promise<MaintenanceResult> {
    const accounts = (await this.db.pool.query<{ id: string }>('SELECT id FROM jobs_accounts_with_pending() AS id')).rows;
    const result: MaintenanceResult = { accounts: accounts.length, expired: 0, reminded: 0 };

    for (const { id: accountId } of accounts) {
      try {
        const expired = await this.bookings.expireStale(accountId);
        result.expired += expired.length;
        for (const bookingId of expired) await this.send({ type: 'booking.expired', accountId, bookingId });

        const due = await this.bookings.markReminders(accountId, MASTER_REMINDER_AFTER_MIN);
        result.reminded += due.length;
        for (const r of due) await this.send({ type: 'booking.master_reminder', accountId, bookingId: r.bookingId, staffId: r.staffId });
      } catch (error) {
        this.logger.error(`account ${accountId}: ${(error as Error).message}`);
      }
    }
    return result;
  }

  private async send(event: Parameters<Notifier['notify']>[0]): Promise<void> {
    try {
      await this.notifier.notify(event);
    } catch (error) {
      this.logger.error(`notify ${event.type} booking=${event.bookingId}: ${(error as Error).message}`);
    }
  }
}
