import type { PoolClient } from 'pg';
import type { Db } from '../db/db';
import { NotFoundError, ValidationError } from '../errors';
import { computeSlots, type Interval, type WorkingInterval } from './slots';
import { addDays, localDate, localDayRange } from './zoned-time';

export interface StaffSettings {
  slotStepMin: number;
  bookingHorizonDays: number;
  minLeadMinutes: number;
}

export interface TimeBlock {
  id: string;
  start: Date;
  end: Date;
  reason: string | null;
}

/** Длительность, буфер и настройки, нужные для расчёта слотов конкретной услуги у специалиста. */
export interface SlotContext extends StaffSettings {
  staffId: string;
  timeZone: string;
  durationMin: number;
  bufferMin: number;
}

/** Максимальный диапазон одного запроса слотов, чтобы публичный эндпоинт нельзя было нагрузить. */
export const MAX_SLOT_RANGE_DAYS = 31;

function toMinutes(time: string): number {
  // PostgreSQL time: HH:MM:SS; 24:00:00 допустимо как конец дня.
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function toTime(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Рабочее время, выходные и свободные слоты (D-043). Регулярный график: working_hours (нет строк на день
 * недели = выходной). Разовые выходные, отпуск, обед: time_blocks. Все методы работают под RLS Account.
 */
export class AvailabilityService {
  constructor(private readonly db: Db) {}

  async getSettings(accountId: string, staffId: string): Promise<StaffSettings> {
    return this.db.withAccount(accountId, async (client) => {
      const row = (await client.query<{ slot_step_min: number; booking_horizon_days: number; min_lead_minutes: number }>(
        'SELECT slot_step_min, booking_horizon_days, min_lead_minutes FROM staff WHERE id = $1',
        [staffId],
      )).rows[0];
      if (!row) throw new NotFoundError('staff');
      return { slotStepMin: row.slot_step_min, bookingHorizonDays: row.booking_horizon_days, minLeadMinutes: row.min_lead_minutes };
    });
  }

  async updateSettings(accountId: string, staffId: string, patch: Partial<StaffSettings>): Promise<StaffSettings> {
    await this.db.withAccount(accountId, async (client) => {
      const updated = await client.query(
        `UPDATE staff SET slot_step_min = COALESCE($2, slot_step_min),
                          booking_horizon_days = COALESCE($3, booking_horizon_days),
                          min_lead_minutes = COALESCE($4, min_lead_minutes)
          WHERE id = $1`,
        [staffId, patch.slotStepMin ?? null, patch.bookingHorizonDays ?? null, patch.minLeadMinutes ?? null],
      );
      if (updated.rowCount === 0) throw new NotFoundError('staff');
    });
    return this.getSettings(accountId, staffId);
  }

  async getWorkingHours(accountId: string, staffId: string): Promise<Array<{ weekday: number; start: string; end: string }>> {
    return this.db.withAccount(accountId, async (client) => {
      await this.requireStaff(client, staffId);
      const rows = await client.query<{ weekday: number; start_time: string; end_time: string }>(
        'SELECT weekday, start_time::text, end_time::text FROM working_hours WHERE staff_id = $1 ORDER BY weekday, start_time',
        [staffId],
      );
      return rows.rows.map((r) => ({ weekday: r.weekday, start: r.start_time.slice(0, 5), end: r.end_time.slice(0, 5) }));
    });
  }

  /** Заменяет недельный график целиком. Интервалы одного дня не должны пересекаться. */
  async setWorkingHours(accountId: string, staffId: string, intervals: readonly WorkingInterval[]): Promise<void> {
    const errors: Record<string, string> = {};
    intervals.forEach((w, i) => {
      if (!Number.isInteger(w.weekday) || w.weekday < 0 || w.weekday > 6) errors[`${i}.weekday`] = '0 (Sunday) to 6 (Saturday)';
      if (!(w.start < w.end) || w.start < 0 || w.end > 24 * 60) errors[`${i}.end`] = 'must be after start';
    });
    const sorted = [...intervals].sort((a, b) => a.weekday - b.weekday || a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (prev.weekday === cur.weekday && cur.start < prev.end) errors[`weekday.${cur.weekday}`] = 'intervals overlap';
    }
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);

    await this.db.withAccount(accountId, async (client) => {
      await this.requireStaff(client, staffId);
      await client.query('DELETE FROM working_hours WHERE staff_id = $1', [staffId]);
      for (const w of intervals) {
        await client.query(
          'INSERT INTO working_hours (account_id, staff_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4, $5)',
          [accountId, staffId, w.weekday, toTime(w.start), w.end === 24 * 60 ? '24:00' : toTime(w.end)],
        );
      }
    });
  }

  async addTimeBlock(accountId: string, staffId: string, start: Date, end: Date, reason: string | null): Promise<TimeBlock> {
    if (!(start < end)) throw new ValidationError({ end: 'must be after start' });
    return this.db.withAccount(accountId, async (client) => {
      await this.requireStaff(client, staffId);
      return this.insertBlock(client, accountId, staffId, start, end, reason);
    });
  }

  /** Выходной день целиком: от местной полуночи до следующей, в часовом поясе Account (D-043). */
  async addDayOff(accountId: string, staffId: string, date: string, reason: string | null): Promise<TimeBlock> {
    return this.db.withAccount(accountId, async (client) => {
      await this.requireStaff(client, staffId);
      const { start, end } = localDayRange(date, await this.timeZone(client));
      return this.insertBlock(client, accountId, staffId, start, end, reason ?? 'day_off');
    });
  }

  async listTimeBlocks(accountId: string, staffId: string, from: Date, to: Date): Promise<TimeBlock[]> {
    return this.db.withAccount(accountId, async (client) => {
      const rows = await client.query<{ id: string; s: Date; e: Date; reason: string | null }>(
        `SELECT id, lower(range) AS s, upper(range) AS e, reason FROM time_blocks
          WHERE staff_id = $1 AND range && tstzrange($2::timestamptz, $3::timestamptz) ORDER BY lower(range)`,
        [staffId, from, to],
      );
      return rows.rows.map((r) => ({ id: r.id, start: r.s, end: r.e, reason: r.reason }));
    });
  }

  async removeTimeBlock(accountId: string, staffId: string, blockId: string): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const deleted = await client.query('DELETE FROM time_blocks WHERE id = $1 AND staff_id = $2', [blockId, staffId]);
      if (deleted.rowCount === 0) throw new NotFoundError('time block');
    });
  }

  /** Свободные слоты для варианта услуги на локальные даты [fromDate, toDate]. */
  async slots(accountId: string, staffId: string, variantId: string, fromDate: string, toDate: string, now = new Date()): Promise<Date[]> {
    return this.db.withAccount(accountId, async (client) => {
      const ctx = await this.slotContext(client, staffId, variantId);
      return this.slotsWithin(client, ctx, fromDate, toDate, now);
    });
  }

  /** Контекст расчёта: специалист должен оказывать услугу варианта (staff_services). */
  async slotContext(client: PoolClient, staffId: string, variantId: string): Promise<SlotContext> {
    const row = (await client.query<{
      duration_min: number;
      buffer_min: number;
      slot_step_min: number;
      booking_horizon_days: number;
      min_lead_minutes: number;
      timezone: string;
    }>(
      `SELECT COALESCE(ss.override_duration_min, v.duration_min) AS duration_min, v.buffer_min,
              st.slot_step_min, st.booking_horizon_days, st.min_lead_minutes, a.timezone
         FROM service_variants v
         JOIN services s ON s.id = v.service_id AND s.active
         JOIN staff_services ss ON ss.service_id = v.service_id AND ss.staff_id = $1
         JOIN staff st ON st.id = ss.staff_id AND st.active
         JOIN accounts a ON a.id = st.account_id
        WHERE v.id = $2 AND v.active`,
      [staffId, variantId],
    )).rows[0];
    if (!row) throw new NotFoundError('service variant for this staff member');
    return {
      staffId,
      timeZone: row.timezone,
      durationMin: row.duration_min,
      bufferMin: row.buffer_min,
      slotStepMin: row.slot_step_min,
      bookingHorizonDays: row.booking_horizon_days,
      minLeadMinutes: row.min_lead_minutes,
    };
  }

  /** ignoreBookingId: при переносе собственная запись клиента не считается занятым временем. */
  async slotsWithin(
    client: PoolClient,
    ctx: SlotContext,
    fromDate: string,
    toDate: string,
    now: Date,
    ignoreBookingId: string | null = null,
  ): Promise<Date[]> {
    if (toDate < fromDate) throw new ValidationError({ to: 'must not be before from' });
    if (addDays(fromDate, MAX_SLOT_RANGE_DAYS) <= toDate) throw new ValidationError({ to: `at most ${MAX_SLOT_RANGE_DAYS} days` });

    // С запасом в сутки с каждой стороны: локальные сутки не совпадают с сутками UTC.
    const rangeStart = new Date(Date.parse(`${addDays(fromDate, -1)}T00:00:00Z`));
    const rangeEnd = new Date(Date.parse(`${addDays(toDate, 2)}T00:00:00Z`));

    const hours = await client.query<{ weekday: number; start_time: string; end_time: string }>(
      'SELECT weekday, start_time::text, end_time::text FROM working_hours WHERE staff_id = $1',
      [ctx.staffId],
    );
    // Занятость как в bookings_no_overlap: pending с действующим hold и confirmed; просроченный hold слот не держит.
    const busy = await client.query<{ s: Date; e: Date }>(
      `SELECT lower(slot) AS s, upper(slot) AS e FROM bookings
        WHERE staff_id = $1 AND slot && tstzrange($2::timestamptz, $3::timestamptz)
          AND (status = 'confirmed' OR (status = 'pending' AND hold_expires_at > now()))
          AND ($4::uuid IS NULL OR id <> $4)
       UNION ALL
       SELECT lower(range), upper(range) FROM time_blocks
        WHERE staff_id = $1 AND range && tstzrange($2::timestamptz, $3::timestamptz)`,
      [ctx.staffId, rangeStart, rangeEnd, ignoreBookingId],
    );

    return computeSlots({
      timeZone: ctx.timeZone,
      fromDate,
      toDate,
      workingHours: hours.rows.map((r) => ({ weekday: r.weekday, start: toMinutes(r.start_time), end: toMinutes(r.end_time) })),
      busy: busy.rows.map((r): Interval => ({ start: r.s, end: r.e })),
      durationMin: ctx.durationMin,
      bufferMin: ctx.bufferMin,
      stepMin: ctx.slotStepMin,
      now,
      minLeadMinutes: ctx.minLeadMinutes,
      horizonDays: ctx.bookingHorizonDays,
    });
  }

  /** Проверка, что startsAt входит в предлагаемые слоты (публичная запись не может выбрать произвольное время). */
  async isOffered(client: PoolClient, ctx: SlotContext, startsAt: Date, now: Date, ignoreBookingId: string | null = null): Promise<boolean> {
    const date = localDate(startsAt, ctx.timeZone);
    const slots = await this.slotsWithin(client, ctx, date, date, now, ignoreBookingId);
    return slots.some((s) => s.getTime() === startsAt.getTime());
  }

  private async requireStaff(client: PoolClient, staffId: string): Promise<void> {
    const found = await client.query('SELECT 1 FROM staff WHERE id = $1', [staffId]);
    if (found.rowCount === 0) throw new NotFoundError('staff');
  }

  private async timeZone(client: PoolClient): Promise<string> {
    const row = (await client.query<{ timezone: string }>('SELECT timezone FROM accounts')).rows[0];
    if (!row) throw new NotFoundError('account');
    return row.timezone;
  }

  private async insertBlock(client: PoolClient, accountId: string, staffId: string, start: Date, end: Date, reason: string | null): Promise<TimeBlock> {
    const row = (await client.query<{ id: string }>(
      "INSERT INTO time_blocks (account_id, staff_id, range, reason) VALUES ($1, $2, tstzrange($3::timestamptz, $4::timestamptz, '[)'), $5) RETURNING id",
      [accountId, staffId, start, end, reason],
    )).rows[0]!;
    return { id: row.id, start, end, reason };
  }
}
