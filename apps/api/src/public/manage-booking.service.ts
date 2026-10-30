import { pickText, type BookingStatus, type Locale } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import type { AvailabilityService } from '../availability/availability.service';
import type { BookingsService } from '../bookings/bookings.service';
import { DEFAULT_POLICY } from '../bookings/payments';
import type { Db } from '../db/db';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { notifySafely, type BookingNotification, type Notifier } from '../jobs/notifier';
import type { RateLimiter } from '../rate-limit';
import { buildIcs } from './ics';
import type { ManageTokens } from './manage-token';

const MANAGE_REQUESTS_PER_IP_HOUR = 120;

interface ManagedRow {
  id: string;
  account_id: string;
  staff_id: string;
  client_id: string;
  service_id: string;
  variant_id: string;
  starts_at: Date;
  ends_at: Date;
  status: BookingStatus;
  reschedule_count: number;
  policy_id: string | null;
  policy_version: number | null;
  free_cancel_hours: number | null;
  max_reschedules: number | null;
  staff_name: string;
  staff_slug: string;
  timezone: string;
  service_name: Record<string, string>;
  variant_name: Record<string, string>;
  pay_amount: string | null;
  pay_code: string | null;
  pay_status: string | null;
  blik_phone: string | null;
  payment_recipient: string | null;
}

export interface ManagedBooking {
  status: BookingStatus;
  startsAt: Date;
  endsAt: Date;
  staffName: string;
  /** Для ссылки «записаться снова» на страницу специалиста. */
  staffSlug: string;
  /** Пояс Account: время визита показывается по нему, а не по браузеру. */
  timeZone: string;
  /** Для «записаться снова»: та же услуга и вариант у того же специалиста. */
  serviceId: string;
  variantId: string;
  service: Record<string, string>;
  variant: Record<string, string>;
  policy: { freeCancelHours: number; maxReschedules: number; rescheduleCount: number; deadline: Date };
  canCancel: boolean;
  /** Отмена сейчас будет поздней: оплата удерживается по политике мастера (D-013). */
  lateCancel: boolean;
  canReschedule: boolean;
  /** После дедлайна вместо переноса клиент видит «Связаться с мастером» (D-012). */
  contactMaster: boolean;
  bookingFee: { amount: number; code: string; status: string; blikPhone: string | null; recipient: string | null } | null;
  /** Если запись перенесена: ссылка управления новой записью. */
  rescheduledToToken: string | null;
}

function rules(row: ManagedRow, now: Date) {
  const freeCancelHours = row.free_cancel_hours ?? DEFAULT_POLICY.freeCancelHours;
  const maxReschedules = row.max_reschedules ?? DEFAULT_POLICY.maxReschedules;
  const deadline = new Date(row.starts_at.getTime() - freeCancelHours * 3_600_000);
  const active = row.status === 'pending' || row.status === 'confirmed';
  const started = now >= row.starts_at;
  return {
    freeCancelHours,
    maxReschedules,
    deadline,
    canCancel: active && !started,
    lateCancel: now > deadline,
    beforeDeadline: now <= deadline,
    canReschedule: row.status === 'confirmed' && now <= deadline && row.reschedule_count < maxReschedules,
    started,
  };
}

/**
 * Самообслуживание клиента по ссылке из подтверждения и напоминания (BOOKING_FLOW.md, раздел 5; D-012, D-013, D-015):
 * просмотр, отмена, перенос. Правила берутся из снимка политики на момент исходной записи.
 */
export class ManageBookingService {
  constructor(
    private readonly db: Db,
    private readonly availability: AvailabilityService,
    private readonly bookings: BookingsService,
    private readonly tokens: ManageTokens,
    private readonly limiter: RateLimiter,
    private readonly notifier: Notifier,
  ) {}

  async view(token: string, ip: string, now = new Date()): Promise<ManagedBooking> {
    const { accountId, bookingId } = await this.open(token, ip);
    return this.db.withAccount(accountId, async (client) => {
      const row = await this.load(client, bookingId, false);
      const r = rules(row, now);
      const next = row.status === 'rescheduled'
        ? (await client.query<{ id: string }>('SELECT id FROM bookings WHERE rescheduled_from = $1', [bookingId])).rows[0]
        : undefined;
      return {
        status: row.status,
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        staffName: row.staff_name,
        staffSlug: row.staff_slug,
        timeZone: row.timezone,
        serviceId: row.service_id,
        variantId: row.variant_id,
        service: row.service_name,
        variant: row.variant_name,
        policy: { freeCancelHours: r.freeCancelHours, maxReschedules: r.maxReschedules, rescheduleCount: row.reschedule_count, deadline: r.deadline },
        canCancel: r.canCancel,
        lateCancel: r.canCancel && r.lateCancel,
        canReschedule: r.canReschedule,
        contactMaster: r.canCancel && !r.canReschedule,
        bookingFee: row.pay_code
          ? { amount: Number(row.pay_amount), code: row.pay_code, status: row.pay_status!, blikPhone: row.blik_phone, recipient: row.payment_recipient }
          : null,
        rescheduledToToken: next ? this.tokens.issue(accountId, next.id) : null,
      };
    });
  }

  /**
   * Файл календаря для «Добавить в календарь» (Apple, Outlook): только для действующей записи (ждёт мастера или
   * подтверждена). Название на языке клиента, в описании ссылка управления записью.
   */
  async ics(token: string, ip: string, language: Locale, publicUrl: string, now = new Date()): Promise<string> {
    const { accountId, bookingId } = await this.open(token, ip);
    return this.db.withAccount(accountId, async (client) => {
      const row = await this.load(client, bookingId, false);
      if (row.status !== 'pending' && row.status !== 'confirmed') throw new ConflictError('NOT_ACTIVE', 'The booking is not active');
      const link = `${publicUrl}/b/${token}?lang=${language}`;
      return buildIcs({
        uid: `${row.id}@rezerwapp`,
        start: row.starts_at,
        end: row.ends_at,
        summary: `${pickText(row.service_name, language)} · ${row.staff_name}`,
        description: link,
        url: link,
        tentative: row.status === 'pending',
        now,
      });
    });
  }

  /** Свободное время для переноса: та же услуга у того же специалиста; своя запись не считается занятой. */
  async slots(token: string, ip: string, fromDate: string, toDate: string, now = new Date()): Promise<Date[]> {
    const { accountId, bookingId } = await this.open(token, ip);
    return this.db.withAccount(accountId, async (client) => {
      const row = await this.load(client, bookingId, false);
      if (!rules(row, now).canReschedule) return [];
      const ctx = await this.availability.slotContext(client, row.staff_id, row.variant_id);
      return this.availability.slotsWithin(client, ctx, fromDate, toDate, now, bookingId);
    });
  }

  async cancel(token: string, ip: string, now = new Date()): Promise<{ status: BookingStatus; late: boolean; payment: string | null }> {
    const { accountId, bookingId } = await this.open(token, ip);
    const result = await this.db.withAccount(accountId, async (client) => {
      const row = await this.load(client, bookingId, true);
      const r = rules(row, now);
      if (r.started) throw new ConflictError('BOOKING_STARTED', 'The visit has already started');
      if (!r.canCancel) throw new ConflictError('NOT_CANCELLABLE', `Booking is ${row.status}`);
      await this.bookings.transitionIn(client, { accountId, bookingId, to: 'cancelled_by_client', actor: 'client' });
      const payment = (await client.query<{ status: string }>('SELECT status FROM payment_requests WHERE booking_id = $1', [bookingId])).rows[0];
      return { status: 'cancelled_by_client' as const, late: r.lateCancel, payment: payment?.status ?? null };
    });
    await this.send({ type: 'booking.cancelled_by_client', accountId, bookingId, late: result.late });
    return result;
  }

  /**
   * Перенос: исходная запись закрывается как rescheduled, новая создаётся confirmed (мастер уже принял клиента)
   * с тем же снимком политики и счётчиком переносов + 1; оплата переходит на новую запись без повторного платежа.
   */
  async reschedule(token: string, ip: string, startsAt: Date, now = new Date()): Promise<{ token: string; startsAt: Date; endsAt: Date; status: BookingStatus }> {
    const { accountId, bookingId } = await this.open(token, ip);
    const result = await this.db.withAccount(accountId, async (client) => {
      const row = await this.load(client, bookingId, true);
      const r = rules(row, now);
      if (row.status !== 'confirmed') throw new ConflictError('NOT_RESCHEDULABLE', `Booking is ${row.status}`);
      if (!r.beforeDeadline) throw new ConflictError('RESCHEDULE_TOO_LATE', 'Rescheduling is closed, contact the specialist');
      if (row.reschedule_count >= r.maxReschedules) throw new ConflictError('RESCHEDULE_LIMIT', 'No reschedules left');
      if (startsAt.getTime() === row.starts_at.getTime()) throw new ValidationError({ startsAt: 'same as the current time' });

      const ctx = await this.availability.slotContext(client, row.staff_id, row.variant_id);
      if (!(await this.availability.isOffered(client, ctx, startsAt, now, bookingId))) {
        throw new ConflictError('SLOT_NOT_AVAILABLE', 'This time is not offered');
      }

      await this.bookings.transitionIn(client, { accountId, bookingId, to: 'rescheduled', actor: 'client' });
      const created = await this.bookings.createIn(client, {
        accountId,
        staffId: row.staff_id,
        clientId: row.client_id,
        serviceId: row.service_id,
        variantId: row.variant_id,
        startsAt,
        requiresApproval: false,
        actor: 'client',
        reschedule: { fromId: bookingId, count: row.reschedule_count + 1, policyId: row.policy_id, policyVersion: row.policy_version },
      });
      await client.query('UPDATE payment_requests SET booking_id = $2 WHERE booking_id = $1', [bookingId, created.id]);
      return created;
    });
    await this.send({ type: 'booking.rescheduled', accountId, bookingId: result.id, fromBookingId: bookingId });
    return { token: this.tokens.issue(accountId, result.id), startsAt: result.startsAt, endsAt: result.endsAt, status: result.status };
  }

  private async open(token: string, ip: string): Promise<{ accountId: string; bookingId: string }> {
    await this.limiter.hit(`manage:ip:${ip}`, MANAGE_REQUESTS_PER_IP_HOUR, 3600);
    const ref = this.tokens.verify(token);
    if (!ref) throw new NotFoundError('booking');
    return ref;
  }

  private async load(client: PoolClient, bookingId: string, lock: boolean): Promise<ManagedRow> {
    const row = (await client.query<ManagedRow>(
      `SELECT b.id, b.account_id, b.staff_id, b.client_id, b.service_id, b.variant_id, b.starts_at, b.ends_at, b.status,
              b.reschedule_count, b.policy_id, b.policy_version, p.free_cancel_hours, p.max_reschedules,
              st.display_name AS staff_name, st.public_slug AS staff_slug, a.timezone, sv.name_i18n AS service_name, v.name_i18n AS variant_name,
              pr.amount AS pay_amount, pr.code AS pay_code, pr.status AS pay_status, a.blik_phone, a.payment_recipient
         FROM bookings b
         JOIN staff st ON st.id = b.staff_id
         JOIN services sv ON sv.id = b.service_id
         JOIN service_variants v ON v.id = b.variant_id
         JOIN accounts a ON a.id = b.account_id
         LEFT JOIN policies p ON p.account_id = b.account_id AND p.id = b.policy_id
         LEFT JOIN payment_requests pr ON pr.booking_id = b.id
        WHERE b.id = $1
        ${lock ? 'FOR UPDATE OF b' : ''}`,
      [bookingId],
    )).rows[0];
    if (!row) throw new NotFoundError('booking');
    return row;
  }

  private send(event: BookingNotification): Promise<void> {
    return notifySafely(this.notifier, event);
  }
}
