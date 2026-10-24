import { canTransition, type BookingStatus } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import type { Db } from '../db/db';
import {
  ClientBlockedError,
  HoldExpiredError,
  InvalidTransitionError,
  NotFoundError,
  SlotTakenError,
  VersionConflictError,
} from './errors';

export type Actor = 'client' | 'master' | 'system' | 'offline_sync';

export interface Booking {
  id: string;
  accountId: string;
  staffId: string;
  clientId: string;
  serviceId: string;
  variantId: string;
  startsAt: Date;
  endsAt: Date;
  bufferMin: number;
  capacity: number;
  status: BookingStatus;
  holdExpiresAt: Date | null;
  policyId: string | null;
  policyVersion: number | null;
  version: number;
}

export interface CreateBookingInput {
  accountId: string;
  staffId: string;
  clientId: string;
  serviceId: string;
  variantId: string;
  startsAt: Date;
  /** true: заявка уходит в pending с hold; false: сразу confirmed (гибридный режим, D-016). */
  requiresApproval: boolean;
  /** По умолчанию берётся из политики услуги, иначе 120 минут (D-017). */
  holdMinutes?: number;
  capacity?: number;
  customFields?: Record<string, unknown>;
  actor?: Actor;
}

export interface TransitionInput {
  accountId: string;
  bookingId: string;
  to: BookingStatus;
  actor: Actor;
  /** Если задана, запись изменится только при совпадении версии (оптимистичная блокировка редактирования). */
  expectedVersion?: number;
}

const DEFAULT_HOLD_MINUTES = 120;
const EXCLUSION_VIOLATION = '23P01';

interface BookingRow {
  id: string;
  account_id: string;
  staff_id: string;
  client_id: string;
  service_id: string;
  variant_id: string;
  starts_at: Date;
  ends_at: Date;
  buffer_min: number;
  capacity: number;
  status: BookingStatus;
  hold_expires_at: Date | null;
  policy_id: string | null;
  policy_version: number | null;
  version: number;
}

function toBooking(row: BookingRow): Booking {
  return {
    id: row.id,
    accountId: row.account_id,
    staffId: row.staff_id,
    clientId: row.client_id,
    serviceId: row.service_id,
    variantId: row.variant_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    bufferMin: row.buffer_min,
    capacity: row.capacity,
    status: row.status,
    holdExpiresAt: row.hold_expires_at,
    policyId: row.policy_id,
    policyVersion: row.policy_version,
    version: row.version,
  };
}

async function addEvent(
  client: PoolClient,
  accountId: string,
  bookingId: string,
  type: string,
  actor: Actor,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    'INSERT INTO booking_events (account_id, booking_id, type, actor, payload) VALUES ($1, $2, $3, $4, $5)',
    [accountId, bookingId, type, actor, JSON.stringify(payload)],
  );
}

export class BookingsService {
  constructor(private readonly db: Db) {}

  /**
   * Создаёт запись. Длительность и буфер берутся из БД (клиент их не присылает). Слот защищён ограничением
   * bookings_no_overlap, поэтому из N параллельных запросов успешен ровно один (D-031).
   * Просроченные hold, мешающие этому слоту, освобождаются в той же транзакции.
   */
  async create(input: CreateBookingInput): Promise<Booking> {
    const actor = input.actor ?? 'client';
    return this.db.withAccount(input.accountId, async (client) => {
      const variant = await client.query<{ duration_min: number; buffer_min: number }>(
        `SELECT COALESCE(ss.override_duration_min, v.duration_min) AS duration_min, v.buffer_min
           FROM service_variants v
           JOIN staff_services ss ON ss.service_id = v.service_id AND ss.staff_id = $1
          WHERE v.id = $2 AND v.service_id = $3 AND v.active`,
        [input.staffId, input.variantId, input.serviceId],
      );
      const variantRow = variant.rows[0];
      if (!variantRow) throw new NotFoundError('service variant for this staff member');

      const blocked = await client.query(
        `SELECT 1
           FROM clients c
           JOIN blacklist_entries b ON b.account_id = c.account_id AND b.phone_hash = c.phone_hash
          WHERE c.id = $1 AND b.expires_at > now()`,
        [input.clientId],
      );
      if ((blocked.rowCount ?? 0) > 0) throw new ClientBlockedError();

      const policy = await client.query<{ id: string | null; version: number | null; hold_minutes: number | null }>(
        `SELECT p.id, p.version, p.hold_minutes
           FROM services s
           LEFT JOIN policies p ON p.account_id = s.account_id AND p.id = s.cancel_policy_id
          WHERE s.id = $1`,
        [input.serviceId],
      );
      const policyRow = policy.rows[0];
      if (!policyRow) throw new NotFoundError('service');

      const holdMinutes = input.holdMinutes ?? policyRow.hold_minutes ?? DEFAULT_HOLD_MINUTES;
      const startsAt = input.startsAt;
      const endsAt = new Date(startsAt.getTime() + variantRow.duration_min * 60_000);
      const slotEnd = new Date(endsAt.getTime() + variantRow.buffer_min * 60_000);

      const released = await client.query<{ id: string }>(
        `UPDATE bookings
            SET status = 'expired', hold_expires_at = NULL, version = version + 1
          WHERE staff_id = $1 AND status = 'pending' AND hold_expires_at <= now()
            AND slot && tstzrange($2::timestamptz, $3::timestamptz, '[)')
          RETURNING id`,
        [input.staffId, startsAt, slotEnd],
      );
      for (const row of released.rows) {
        await addEvent(client, input.accountId, row.id, 'status_changed', 'system', { from: 'pending', to: 'expired' });
      }

      const status: BookingStatus = input.requiresApproval ? 'pending' : 'confirmed';
      let inserted;
      try {
        inserted = await client.query<BookingRow>(
          `INSERT INTO bookings
             (account_id, staff_id, client_id, service_id, variant_id, starts_at, ends_at, buffer_min,
              capacity, status, hold_expires_at, policy_id, policy_version, custom_fields)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text,
                   CASE WHEN $10::text = 'pending' THEN now() + make_interval(mins => $11::int) END,
                   $12, $13, $14)
           RETURNING *`,
          [
            input.accountId,
            input.staffId,
            input.clientId,
            input.serviceId,
            input.variantId,
            startsAt,
            endsAt,
            variantRow.buffer_min,
            input.capacity ?? 1,
            status,
            holdMinutes,
            policyRow.id,
            policyRow.version,
            JSON.stringify(input.customFields ?? {}),
          ],
        );
      } catch (error) {
        if ((error as { code?: string }).code === EXCLUSION_VIOLATION) throw new SlotTakenError();
        throw error;
      }

      const row = inserted.rows[0];
      if (!row) throw new Error('booking insert returned no row');
      await addEvent(client, input.accountId, row.id, 'created', actor, { status });
      return toBooking(row);
    });
  }

  /** Переводит запись в новый статус по правилам BOOKING_FLOW.md и пишет событие. */
  async transition(input: TransitionInput): Promise<Booking> {
    return this.db.withAccount(input.accountId, async (client) => {
      const current = await client.query<{ status: BookingStatus; version: number; hold_over: boolean | null }>(
        `SELECT status, version, (hold_expires_at <= now()) AS hold_over
           FROM bookings WHERE id = $1 FOR UPDATE`,
        [input.bookingId],
      );
      const row = current.rows[0];
      if (!row) throw new NotFoundError('booking');
      if (input.expectedVersion !== undefined && input.expectedVersion !== row.version) {
        throw new VersionConflictError();
      }
      if (!canTransition(row.status, input.to)) throw new InvalidTransitionError(row.status, input.to);
      if (row.status === 'pending' && input.to === 'confirmed' && row.hold_over === true) {
        throw new HoldExpiredError();
      }

      const updated = await client.query<BookingRow>(
        `UPDATE bookings
            SET status = $2, hold_expires_at = NULL, version = version + 1
          WHERE id = $1
          RETURNING *`,
        [input.bookingId, input.to],
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) throw new NotFoundError('booking');
      await addEvent(client, input.accountId, input.bookingId, 'status_changed', input.actor, {
        from: row.status,
        to: input.to,
      });
      return toBooking(updatedRow);
    });
  }

  /** Фоновая задача: переводит просроченные pending в expired. Возвращает число освобождённых слотов. */
  async expireStaleHolds(accountId: string): Promise<number> {
    return this.db.withAccount(accountId, async (client) => {
      const result = await client.query<{ booking_id: string }>(
        `WITH expired AS (
           UPDATE bookings
              SET status = 'expired', hold_expires_at = NULL, version = version + 1
            WHERE status = 'pending' AND hold_expires_at <= now()
            RETURNING id, account_id
         )
         INSERT INTO booking_events (account_id, booking_id, type, actor, payload)
         SELECT account_id, id, 'status_changed', 'system', '{"from":"pending","to":"expired"}'::jsonb FROM expired
         RETURNING booking_id`,
      );
      return result.rowCount ?? 0;
    });
  }
}
