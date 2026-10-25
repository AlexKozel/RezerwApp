import { Logger } from '@nestjs/common';
import type { BookingsService } from '../bookings/bookings.service';
import type { CrmService } from '../clients/crm.service';
import type { Db } from '../db/db';
import { notifySafely, type BookingNotification, type Notifier } from './notifier';

/** Через сколько минут без ответа мастеру уходит напоминание о заявке (D-017). */
export const MASTER_REMINDER_AFTER_MIN = 30;

export interface MaintenanceResult {
  accounts: number;
  expired: number;
  reminded: number;
  clientReminded: number;
  blacklistPurged: number;
}

/**
 * Периодическое обслуживание (D-017, D-024, D-049): истечение hold, напоминание мастеру, напоминание клиенту
 * за 24 часа, очистка blacklist.
 * Account с заявками pending находит функция jobs_accounts_with_pending (миграция 0006), дальше каждый
 * Account обрабатывается под своим RLS. Сбой в одном Account не останавливает остальные.
 */
export class MaintenanceJobs {
  private readonly logger = new Logger('MaintenanceJobs');

  constructor(
    private readonly db: Db,
    private readonly bookings: BookingsService,
    private readonly crm: CrmService,
    private readonly notifier: Notifier,
  ) {}

  async run(): Promise<MaintenanceResult> {
    const accounts = (await this.db.pool.query<{ id: string }>('SELECT id FROM jobs_accounts_with_pending() AS id')).rows;
    const result: MaintenanceResult = { accounts: accounts.length, expired: 0, reminded: 0, clientReminded: 0, blacklistPurged: 0 };

    // D-024: записи blacklist с истёкшим сроком удаляются, а не только перестают действовать.
    const withExpired = (await this.db.pool.query<{ id: string }>('SELECT id FROM jobs_accounts_with_expired_blacklist() AS id')).rows;
    for (const { id: accountId } of withExpired) {
      try {
        result.blacklistPurged += await this.crm.purgeExpiredBlacklist(accountId);
      } catch (error) {
        this.logger.error(`account ${accountId}: blacklist purge: ${(error as Error).message}`);
      }
    }

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

    // Напоминание клиенту за 24 часа до визита (BOOKING_FLOW.md, раздел 6).
    const upcoming = (await this.db.pool.query<{ id: string }>('SELECT id FROM jobs_accounts_with_upcoming() AS id')).rows;
    for (const { id: accountId } of upcoming) {
      try {
        const due = await this.bookings.markClientReminders(accountId);
        result.clientReminded += due.length;
        for (const bookingId of due) await this.send({ type: 'booking.client_reminder', accountId, bookingId });
      } catch (error) {
        this.logger.error(`account ${accountId}: client reminders: ${(error as Error).message}`);
      }
    }
    return result;
  }

  private send(event: BookingNotification): Promise<void> {
    return notifySafely(this.notifier, event);
  }
}
