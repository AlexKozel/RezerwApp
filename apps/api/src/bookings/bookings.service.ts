import { canTransition, type BookingStatus } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import type { Db } from '../db/db';
import { ConflictError } from '../errors';
import { notifySafely, type Notifier } from '../jobs/notifier';
import { applyDiscount, bookingDiscount, clientDiscount } from './discounts';
import { DEFAULT_POLICY, paymentOutcome, settlePayment, type LateCancelRule } from './payments';
import {
  ClientBlockedError,
  HoldExpiredError,
  InvalidTransitionError,
  NotAnIncidentError,
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
  /** Цена на момент записи, уже со скидкой (D-056, D-070); null у записей до снимка цены. */
  price: number | null;
  /** Скидка в записи (D-070): процент и сколько злотых. */
  discountPercent: number | null;
  discountAmount: number | null;
  /** Разовые затраты на этот визит (D-071), если Account их учитывает. */
  extraCost: number | null;
}

/** Запись для календаря мастера. */
export interface CalendarBooking extends Booking {
  clientName: string;
  /** Клиент сейчас «ненадёжный» (D-066): мастеру видно в календаре. */
  clientUnreliable: boolean;
  /** Отменено клиентом позже дедлайна политики. */
  lateCancel: boolean;
  /** Неявка или поздняя отмена прощена мастером (уважительная причина). */
  excused: boolean;
  staffName: string;
  serviceName: Record<string, string>;
  variantName: Record<string, string>;
  price: number | null;
  payment: { amount: number; code: string; status: string } | null;
}

interface CalendarRow {
  client_name: string;
  client_visits_left: number | null;
  staff_name: string;
  service_name: Record<string, string>;
  variant_name: Record<string, string>;
  price: string | null;
  pay_amount: string | null;
  pay_code: string | null;
  pay_status: string | null;
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
  /**
   * Перенос (BOOKING_FLOW.md, раздел 5): новая запись наследует снимок политики исходной (D-015),
   * а не текущую политику услуги, и считает переносы.
   */
  reschedule?: { fromId: string; count: number; policyId: string | null; policyVersion: number | null };
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
/** Пространство ключей advisory-блокировок записей (727001 занят раннером миграций). */
const BOOKING_LOCK_NAMESPACE = 727002;

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
  late_cancel: boolean;
  excused_at: Date | null;
  price: string | null;
  discount_percent: number | null;
  discount_amount: string | null;
  extra_cost: string | null;
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
    price: row.price === null ? null : Number(row.price),
    discountPercent: row.discount_percent,
    discountAmount: row.discount_amount === null ? null : Number(row.discount_amount),
    extraCost: row.extra_cost === null ? null : Number(row.extra_cost),
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
  constructor(
    private readonly db: Db,
    /** Уведомления о смене статуса (D-052). Необязателен: тесты и CLI работают без него. */
    private readonly notifier?: Notifier,
  ) {}

  /**
   * Создаёт запись. Длительность и буфер берутся из БД (клиент их не присылает). Слот защищён ограничением
   * bookings_no_overlap, поэтому из N параллельных запросов успешен ровно один (D-031).
   * Просроченные hold, мешающие этому слоту, освобождаются в той же транзакции.
   */
  async create(input: CreateBookingInput): Promise<Booking> {
    return this.db.withAccount(input.accountId, (client) => this.createIn(client, input));
  }

  /** То же, что create, внутри уже открытой транзакции withAccount (для сценариев из нескольких шагов). */
  async createIn(client: PoolClient, input: CreateBookingInput): Promise<Booking> {
    const actor = input.actor ?? 'client';
    const variant = await client.query<{ duration_min: number; buffer_min: number; price: string }>(
      `SELECT COALESCE(ss.override_duration_min, v.duration_min) AS duration_min, v.buffer_min,
              COALESCE(ss.override_price, v.price) AS price
         FROM service_variants v
         JOIN staff_services ss ON ss.service_id = v.service_id AND ss.staff_id = $1
        WHERE v.id = $2 AND v.service_id = $3 AND v.active`,
      [input.staffId, input.variantId, input.serviceId],
    );
    const variantRow = variant.rows[0];
    if (!variantRow) throw new NotFoundError('service variant for this staff member');
    // D-070: скидка клиента фиксируется в записи; перенос сохраняет скидку исходной записи (снимок, D-015).
    const discount = input.reschedule ? await bookingDiscount(client, input.reschedule.fromId) : await clientDiscount(client, input.clientId);
    const priced = applyDiscount(Number(variantRow.price), discount);

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

    // Параллельные вставки пересекающихся слотов ждут друг друга на EXCLUDE и могут попасть в deadlock
    // (клиент получил бы ошибку 500 через секунды). Блокировка на специалиста до конца транзакции ставит их
    // в очередь: следующая видит закоммиченную запись и получает обычное «слот занят». EXCLUDE остаётся гарантией.
    await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [BOOKING_LOCK_NAMESPACE, input.staffId]);

    const released = await client.query<{ id: string }>(
      `UPDATE bookings
          SET status = 'expired', hold_expires_at = NULL, version = version + 1
        WHERE staff_id = $1 AND status = 'pending' AND hold_expires_at <= now()
          AND slot && tstzrange($2::timestamptz, $3::timestamptz, '[)')
        RETURNING id`,
      [input.staffId, startsAt, slotEnd],
    );
    for (const row of released.rows) {
      await settlePayment(client, row.id, paymentOutcome('expired', false, DEFAULT_POLICY.depositOnLateCancel));
      await addEvent(client, input.accountId, row.id, 'status_changed', 'system', { from: 'pending', to: 'expired' });
    }

    const status: BookingStatus = input.requiresApproval ? 'pending' : 'confirmed';
    let inserted;
    try {
      inserted = await client.query<BookingRow>(
        `INSERT INTO bookings
           (account_id, staff_id, client_id, service_id, variant_id, starts_at, ends_at, buffer_min,
            capacity, status, hold_expires_at, policy_id, policy_version, custom_fields, reschedule_count, rescheduled_from, price,
            discount_percent, discount_amount, discount_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::text,
                 CASE WHEN $10::text = 'pending' THEN now() + make_interval(mins => $11::int) END,
                 $12, $13, $14, $15, $16, $17, $18, $19, $20)
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
          input.reschedule ? input.reschedule.policyId : policyRow.id,
          input.reschedule ? input.reschedule.policyVersion : policyRow.version,
          JSON.stringify(input.customFields ?? {}),
          input.reschedule?.count ?? 0,
          input.reschedule?.fromId ?? null,
          // Снимок цены (D-056): персональная цена специалиста или цена варианта на момент записи, со скидкой (D-070).
          priced.price,
          discount?.percent ?? null,
          priced.amount,
          discount?.reason ?? null,
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code === EXCLUSION_VIOLATION) throw new SlotTakenError();
      throw error;
    }

    const row = inserted.rows[0];
    if (!row) throw new Error('booking insert returned no row');
    // D-068: запись к специалисту на день из периода закрывает ожидание клиента в его очереди.
    await client.query(
      `UPDATE waitlist_entries SET status = 'booked', updated_at = now()
        WHERE client_id = $1 AND staff_id = $2 AND status = 'waiting'
          AND ($3::timestamptz AT TIME ZONE (SELECT timezone FROM accounts))::date BETWEEN date_from AND date_to`,
      [input.clientId, input.staffId, input.startsAt],
    );
    await addEvent(client, input.accountId, row.id, 'created', actor, input.reschedule ? { status, rescheduledFrom: input.reschedule.fromId } : { status });
    return toBooking(row);
  }

  /**
   * Записи Account, начинающиеся в [from, to), для календаря мастера: с именем клиента, услугой и оплатой.
   * Телефон клиента сюда не входит: он расшифровывается только в карточке клиента с записью в аудит (D-050).
   */
  async list(accountId: string, from: Date, to: Date, staffId?: string): Promise<CalendarBooking[]> {
    return this.db.withAccount(accountId, (client) =>
      this.calendarRows(client, 'b.starts_at >= $1 AND b.starts_at < $2 AND ($3::uuid IS NULL OR b.staff_id = $3)', [from, to, staffId ?? null]),
    );
  }

  /**
   * Оплаты, которые мастер должен вернуть или проверить (D-072): возвращена по правилам (returned) или запись
   * закончилась до подтверждения оплаты (to_check). Висят в календаре, пока мастер не закроет каждую.
   */
  async paymentsDue(accountId: string, staffId?: string): Promise<CalendarBooking[]> {
    return this.db.withAccount(accountId, (client) =>
      this.calendarRows(client, "pr.status IN ('returned', 'to_check') AND ($1::uuid IS NULL OR b.staff_id = $1)", [staffId ?? null]),
    );
  }

  /**
   * Мастер закрывает вопрос с оплатой (D-072): refunded — вернул (из returned или to_check), not_received —
   * проверил банк, перевода не было (только из to_check). Клиенту уходит сообщение о возврате.
   */
  async settlePayment(accountId: string, bookingId: string, result: 'refunded' | 'not_received'): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const allowed = result === 'refunded' ? ['returned', 'to_check'] : ['to_check'];
      const updated = await client.query(
        'UPDATE payment_requests SET status = $2, settled_at = now() WHERE booking_id = $1 AND status = ANY($3) RETURNING id',
        [bookingId, result, allowed],
      );
      if (updated.rowCount === 0) throw new ConflictError('PAYMENT_NOT_DUE', 'There is nothing to settle for this booking');
      await addEvent(client, accountId, bookingId, 'payment_settled', 'master', { result });
    });
    if (result === 'refunded') await notifySafely(this.notifier, { type: 'payment.refunded', accountId, bookingId });
  }

  private async calendarRows(client: PoolClient, where: string, params: unknown[]): Promise<CalendarBooking[]> {
      const rows = await client.query<BookingRow & CalendarRow>(
        `SELECT b.*, c.name AS client_name, client_unreliable_visits_left(b.client_id) AS client_visits_left,
                st.display_name AS staff_name, sv.name_i18n AS service_name, v.name_i18n AS variant_name,
                pr.amount AS pay_amount, pr.code AS pay_code, pr.status AS pay_status
           FROM bookings b
           JOIN clients c ON c.id = b.client_id
           JOIN staff st ON st.id = b.staff_id
           JOIN services sv ON sv.id = b.service_id
           JOIN service_variants v ON v.id = b.variant_id
           LEFT JOIN payment_requests pr ON pr.booking_id = b.id
          WHERE ${where}
          ORDER BY b.starts_at`,
        params,
      );
      return rows.rows.map((r) => ({
        ...toBooking(r),
        clientName: r.client_name,
        clientUnreliable: r.client_visits_left !== null,
        lateCancel: r.late_cancel,
        excused: r.excused_at !== null,
        staffName: r.staff_name,
        serviceName: r.service_name,
        variantName: r.variant_name,
        price: r.price === null ? null : Number(r.price),
        payment: r.pay_code ? { amount: Number(r.pay_amount), code: r.pay_code, status: r.pay_status! } : null,
      }));
  }

  /** Переводит запись в новый статус по правилам BOOKING_FLOW.md и пишет событие. */
  async transition(input: TransitionInput): Promise<Booking> {
    const booking = await this.db.withAccount(input.accountId, (client) => this.transitionIn(client, input));
    await notifySafely(this.notifier, { type: 'booking.status_changed', accountId: input.accountId, bookingId: booking.id, to: booking.status });
    return booking;
  }

  /** То же, что transition, внутри открытой транзакции. Заодно фиксирует судьбу оплаты (D-013). */
  async transitionIn(client: PoolClient, input: TransitionInput): Promise<Booking> {
    const current = await client.query<{
      status: BookingStatus;
      version: number;
      hold_over: boolean | null;
      late: boolean;
      rule: LateCancelRule | null;
    }>(
      `SELECT b.status, b.version, (b.hold_expires_at <= now()) AS hold_over,
              now() > b.starts_at - make_interval(hours => COALESCE(p.free_cancel_hours, $2::int)) AS late,
              p.deposit_on_late_cancel AS rule
         FROM bookings b
         LEFT JOIN policies p ON p.account_id = b.account_id AND p.id = b.policy_id
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [input.bookingId, DEFAULT_POLICY.freeCancelHours],
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

    // Поздняя отмена клиентом фиксируется сейчас: дедлайн зависит от момента отмены (D-066).
    const lateCancel = input.to === 'cancelled_by_client' && row.late;
    const updated = await client.query<BookingRow>(
      `UPDATE bookings
          SET status = $2, hold_expires_at = NULL, version = version + 1, late_cancel = $3
        WHERE id = $1
        RETURNING *`,
      [input.bookingId, input.to, lateCancel],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) throw new NotFoundError('booking');
    const payment = await settlePayment(
      client,
      input.bookingId,
      paymentOutcome(input.to, row.late, row.rule ?? DEFAULT_POLICY.depositOnLateCancel),
    );
    await addEvent(client, input.accountId, input.bookingId, 'status_changed', input.actor, {
      from: row.status,
      to: input.to,
      ...(payment ? { payment } : {}),
      ...(lateCancel ? { late: true } : {}),
    });
    return toBooking(updatedRow);
  }

  /**
   * Разовые затраты на визит (D-071): только если Account их учитывает (настройка owner). null стирает.
   */
  async setExtraCost(accountId: string, bookingId: string, amount: number | null): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const on = (await client.query<{ on: boolean }>('SELECT track_visit_costs AS on FROM accounts')).rows[0]?.on;
      if (!on) throw new ConflictError('VISIT_COSTS_OFF', 'Visit costs are not tracked in this account');
      const updated = await client.query('UPDATE bookings SET extra_cost = $2 WHERE id = $1', [bookingId, amount]);
      if (updated.rowCount === 0) throw new NotFoundError('booking');
    });
  }

  /**
   * Уважительная причина (D-066): неявка или поздняя отмена не считается при определении «ненадёжного
   * клиента». excused = false возвращает случай в счёт.
   */
  async excuse(accountId: string, bookingId: string, excused: boolean): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const row = (await client.query<{ status: BookingStatus; late_cancel: boolean }>(
        'SELECT status, late_cancel FROM bookings WHERE id = $1 FOR UPDATE',
        [bookingId],
      )).rows[0];
      if (!row) throw new NotFoundError('booking');
      if (!(row.status === 'no_show' || (row.status === 'cancelled_by_client' && row.late_cancel))) throw new NotAnIncidentError();
      await client.query('UPDATE bookings SET excused_at = CASE WHEN $2 THEN COALESCE(excused_at, now()) END WHERE id = $1', [bookingId, excused]);
      await addEvent(client, accountId, bookingId, excused ? 'excused' : 'excuse_revoked', 'master', {});
    });
  }

  /** Фоновая задача: переводит просроченные pending в expired. Возвращает число освобождённых слотов. */
  async expireStaleHolds(accountId: string): Promise<number> {
    return (await this.expireStale(accountId)).length;
  }

  /** То же, что expireStaleHolds, но возвращает id истёкших записей (для уведомления клиентов). */
  async expireStale(accountId: string): Promise<string[]> {
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
      // Оплата истёкшей заявки (D-072): клиент мог перевести деньги, мастер должен проверить и вернуть.
      for (const r of result.rows) await settlePayment(client, r.booking_id, paymentOutcome('expired', false, DEFAULT_POLICY.depositOnLateCancel));
      return result.rows.map((r) => r.booking_id);
    });
  }

  /**
   * Подтверждённые визиты в ближайшие 24 часа, о которых клиенту ещё не напоминали (BOOKING_FLOW.md, раздел 6).
   * Не напоминаем о записях, сделанных меньше чем за сутки: клиент только что получил подтверждение.
   * Отметка client_reminded и SKIP LOCKED, как в markReminders.
   */
  async markClientReminders(accountId: string): Promise<string[]> {
    return this.db.withAccount(accountId, async (client) => {
      const due = await client.query<{ id: string }>(
        `SELECT b.id FROM bookings b
          WHERE b.status = 'confirmed' AND b.starts_at > now() AND b.starts_at <= now() + interval '24 hours'
            AND b.created_at <= b.starts_at - interval '24 hours'
            AND NOT EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.type = 'client_reminded')
          ORDER BY b.starts_at
          FOR UPDATE OF b SKIP LOCKED`,
      );
      for (const row of due.rows) await addEvent(client, accountId, row.id, 'client_reminded', 'system', {});
      return due.rows.map((r) => r.id);
    });
  }

  /**
   * Заявки pending без ответа мастера дольше olderThanMin минут, о которых ещё не напоминали (D-017).
   * Отметка «напомнили» пишется событием master_reminded в той же транзакции, поэтому напоминание уходит
   * один раз; SKIP LOCKED не даёт двум воркерам взять одну заявку.
   */
  async markReminders(accountId: string, olderThanMin: number): Promise<Array<{ bookingId: string; staffId: string }>> {
    return this.db.withAccount(accountId, async (client) => {
      const due = await client.query<{ id: string; staff_id: string }>(
        `SELECT b.id, b.staff_id FROM bookings b
          WHERE b.status = 'pending' AND b.hold_expires_at > now()
            AND b.created_at <= now() - make_interval(mins => $1::int)
            AND NOT EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.type = 'master_reminded')
          ORDER BY b.created_at
          FOR UPDATE OF b SKIP LOCKED`,
        [olderThanMin],
      );
      for (const row of due.rows) await addEvent(client, accountId, row.id, 'master_reminded', 'system', {});
      return due.rows.map((r) => ({ bookingId: r.id, staffId: r.staff_id }));
    });
  }
}
