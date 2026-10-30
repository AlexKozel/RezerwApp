import { addDays, localDate, offsetMinutes } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import type { AvailabilityService } from '../availability/availability.service';
import type { Db } from '../db/db';
import { ConflictError, NotFoundError } from '../errors';
import type { ManageTokens } from '../public/manage-token';
import type { RateLimiter } from '../rate-limit';

export type PartOfDay = 'any' | 'morning' | 'afternoon' | 'evening';
export const PARTS_OF_DAY: readonly PartOfDay[] = ['any', 'morning', 'afternoon', 'evening'];

/** Сколько действует предложение: потом слот предлагается следующему в очереди (D-068). */
export const OFFER_MINUTES = 30;
/** Предложения уходят только днём по поясу Account: 08:00-21:00. */
const OFFER_FROM_HOUR = 8;
const OFFER_TO_HOUR = 21;
/** Не больше стольких активных очередей у клиента к одному специалисту. */
export const MAX_WAITING_PER_CLIENT = 3;
const VIEW_REQUESTS_PER_IP_HOUR = 60;

export interface WaitlistView {
  status: 'waiting' | 'booked' | 'cancelled' | 'expired';
  staffName: string;
  slug: string;
  serviceId: string;
  variantId: string;
  serviceName: Record<string, string>;
  variantName: Record<string, string>;
  dateFrom: string;
  dateTo: string;
  partOfDay: PartOfDay;
  timeZone: string;
  /** Действующее предложение (ссылка на запись приходит в уведомлении). */
  offer: { startsAt: Date; expiresAt: Date } | null;
}

export interface MasterWaitlistEntry {
  id: string;
  staffId: string;
  staffName: string;
  clientId: string;
  clientName: string;
  serviceName: Record<string, string>;
  variantName: Record<string, string>;
  dateFrom: string;
  dateTo: string;
  partOfDay: PartOfDay;
  createdAt: Date;
  offer: { startsAt: Date; expiresAt: Date } | null;
}

/** Минуты от местной полуночи по настенным часам пояса. */
function localMinutes(at: Date, timeZone: string): number {
  const local = at.getTime() + offsetMinutes(at.getTime(), timeZone) * 60_000;
  return Math.floor((((local % 86_400_000) + 86_400_000) % 86_400_000) / 60_000);
}

/** Утро: до 12:00, день: 12:00-16:59, вечер: с 17:00 (по началу визита). */
export function inPartOfDay(minutes: number, part: PartOfDay): boolean {
  if (part === 'morning') return minutes < 12 * 60;
  if (part === 'afternoon') return minutes >= 12 * 60 && minutes < 17 * 60;
  if (part === 'evening') return minutes >= 17 * 60;
  return true;
}

/**
 * Лист ожидания (D-068). Очередь у специалиста по порядку постановки. Фоновая задача раз в минуту ищет для
 * каждого ожидающего свободный слот в его периоде и части дня и предлагает его на OFFER_MINUTES; слот не
 * резервируется (первый, кто запишется, тот и занял). Не записался: тот же слот предлагается следующему,
 * этому клиенту он больше не предлагается. Запись к специалисту на день из периода закрывает ожидание
 * (BookingsService.createIn), прошедший период его истекает.
 */
export class WaitlistService {
  constructor(
    private readonly db: Db,
    private readonly availability: AvailabilityService,
    private readonly tokens: ManageTokens,
    private readonly limiter: RateLimiter,
  ) {}

  /** Шаг фоновой задачи для одного Account. Возвращает id новых предложений (для уведомлений). */
  async process(accountId: string, now = new Date()): Promise<string[]> {
    return this.db.withAccount(accountId, async (client) => {
      const tz = (await client.query<{ timezone: string }>('SELECT timezone FROM accounts')).rows[0]!.timezone;
      const today = localDate(now, tz);
      await client.query("UPDATE waitlist_entries SET status = 'expired', updated_at = now() WHERE status = 'waiting' AND date_to < $1", [today]);
      const hour = Math.floor(localMinutes(now, tz) / 60);
      if (hour < OFFER_FROM_HOUR || hour >= OFFER_TO_HOUR) return [];

      // Клиенты из blacklist остаются в очереди, но предложений не получают (нейтрально, как и запись, D-024).
      const entries = await client.query<{ id: string; staff_id: string; variant_id: string; date_from: string; date_to: string; part_of_day: PartOfDay }>(
        `SELECT e.id, e.staff_id, e.variant_id, to_char(e.date_from, 'YYYY-MM-DD') AS date_from, to_char(e.date_to, 'YYYY-MM-DD') AS date_to, e.part_of_day
           FROM waitlist_entries e JOIN clients c ON c.id = e.client_id
          WHERE e.status = 'waiting'
            AND NOT EXISTS (SELECT 1 FROM blacklist_entries bl WHERE bl.phone_hash = c.phone_hash AND bl.expires_at > now())
          ORDER BY e.created_at, e.id
          FOR UPDATE OF e SKIP LOCKED`,
      );
      const offers = await client.query<{ entry_id: string; staff_id: string; starts_at: Date; active: boolean }>(
        `SELECT o.entry_id, e.staff_id, o.starts_at, o.expires_at > $1 AS active
           FROM waitlist_offers o JOIN waitlist_entries e ON e.id = o.entry_id`,
        [now],
      );
      const withActiveOffer = new Set(offers.rows.filter((o) => o.active).map((o) => o.entry_id));
      const taken = new Set(offers.rows.filter((o) => o.active).map((o) => `${o.staff_id}|${o.starts_at.toISOString()}`));
      const seen = new Set(offers.rows.map((o) => `${o.entry_id}|${o.starts_at.toISOString()}`));

      const created: string[] = [];
      for (const e of entries.rows) {
        if (withActiveOffer.has(e.id)) continue;
        const from = e.date_from > today ? e.date_from : today;
        if (from > e.date_to) continue;
        let slots: Date[];
        try {
          const ctx = await this.availability.slotContext(client, e.staff_id, e.variant_id);
          slots = await this.availability.slotsWithin(client, ctx, from, e.date_to, now);
        } catch (error) {
          // Услугу сняли или специалист её больше не оказывает: предложить нечего.
          if (error instanceof NotFoundError) continue;
          throw error;
        }
        const slot = slots.find(
          (s) =>
            inPartOfDay(localMinutes(s, tz), e.part_of_day) &&
            !taken.has(`${e.staff_id}|${s.toISOString()}`) &&
            !seen.has(`${e.id}|${s.toISOString()}`),
        );
        if (!slot) continue;
        const offer = await client.query<{ id: string }>(
          `INSERT INTO waitlist_offers (account_id, entry_id, starts_at, expires_at)
           VALUES ($1, $2, $3, $4::timestamptz + make_interval(mins => $5)) RETURNING id`,
          [accountId, e.id, slot, now, OFFER_MINUTES],
        );
        taken.add(`${e.staff_id}|${slot.toISOString()}`);
        created.push(offer.rows[0]!.id);
      }
      return created;
    });
  }

  async view(token: string, ip: string, now = new Date()): Promise<WaitlistView> {
    await this.limiter.hit(`waitlist:ip:${ip}`, VIEW_REQUESTS_PER_IP_HOUR, 3600);
    const ref = this.tokens.verifyWaitlist(token);
    if (!ref) throw new NotFoundError('waitlist entry');
    return this.db.withAccount(ref.accountId, async (client) => {
      const row = (await client.query<{
        status: WaitlistView['status'];
        staff_name: string;
        slug: string;
        service_id: string;
        variant_id: string;
        service_name: Record<string, string>;
        variant_name: Record<string, string>;
        date_from: string;
        date_to: string;
        part_of_day: PartOfDay;
        timezone: string;
      }>(
        `SELECT e.status, st.display_name AS staff_name, st.public_slug AS slug, e.service_id, e.variant_id,
                sv.name_i18n AS service_name, v.name_i18n AS variant_name,
                to_char(e.date_from, 'YYYY-MM-DD') AS date_from, to_char(e.date_to, 'YYYY-MM-DD') AS date_to, e.part_of_day, a.timezone
           FROM waitlist_entries e
           JOIN staff st ON st.id = e.staff_id
           JOIN services sv ON sv.id = e.service_id
           JOIN service_variants v ON v.id = e.variant_id
           JOIN accounts a ON a.id = e.account_id
          WHERE e.id = $1`,
        [ref.entryId],
      )).rows[0];
      if (!row) throw new NotFoundError('waitlist entry');
      return {
        status: row.status,
        staffName: row.staff_name,
        slug: row.slug,
        serviceId: row.service_id,
        variantId: row.variant_id,
        serviceName: row.service_name,
        variantName: row.variant_name,
        dateFrom: row.date_from,
        dateTo: row.date_to,
        partOfDay: row.part_of_day,
        timeZone: row.timezone,
        offer: row.status === 'waiting' ? await activeOffer(client, ref.entryId, now) : null,
      };
    });
  }

  /** Клиент выходит из очереди по ссылке. Повторный выход ничего не меняет. */
  async cancel(token: string, ip: string): Promise<void> {
    await this.limiter.hit(`waitlist:ip:${ip}`, VIEW_REQUESTS_PER_IP_HOUR, 3600);
    const ref = this.tokens.verifyWaitlist(token);
    if (!ref) throw new NotFoundError('waitlist entry');
    await this.db.withAccount(ref.accountId, async (client) => {
      const row = (await client.query<{ status: string }>('SELECT status FROM waitlist_entries WHERE id = $1 FOR UPDATE', [ref.entryId])).rows[0];
      if (!row) throw new NotFoundError('waitlist entry');
      if (row.status === 'cancelled') return;
      if (row.status !== 'waiting') throw new ConflictError('WAITLIST_CLOSED', 'This waitlist entry is no longer active');
      await client.query("UPDATE waitlist_entries SET status = 'cancelled', updated_at = now() WHERE id = $1", [ref.entryId]);
    });
  }

  /** Очередь для мастера: ожидающие клиенты по порядку; staffIds = null — все специалисты Account. */
  async list(accountId: string, staffIds: string[] | null, now = new Date()): Promise<MasterWaitlistEntry[]> {
    return this.db.withAccount(accountId, async (client) => {
      const rows = await client.query<{
        id: string;
        staff_id: string;
        staff_name: string;
        client_id: string;
        client_name: string;
        service_name: Record<string, string>;
        variant_name: Record<string, string>;
        date_from: string;
        date_to: string;
        part_of_day: PartOfDay;
        created_at: Date;
        offer_starts: Date | null;
        offer_expires: Date | null;
      }>(
        `SELECT e.id, e.staff_id, st.display_name AS staff_name, e.client_id, c.name AS client_name,
                sv.name_i18n AS service_name, v.name_i18n AS variant_name,
                to_char(e.date_from, 'YYYY-MM-DD') AS date_from, to_char(e.date_to, 'YYYY-MM-DD') AS date_to,
                e.part_of_day, e.created_at, o.starts_at AS offer_starts, o.expires_at AS offer_expires
           FROM waitlist_entries e
           JOIN staff st ON st.id = e.staff_id
           JOIN clients c ON c.id = e.client_id
           JOIN services sv ON sv.id = e.service_id
           JOIN service_variants v ON v.id = e.variant_id
           LEFT JOIN LATERAL (SELECT starts_at, expires_at FROM waitlist_offers wo
                               WHERE wo.entry_id = e.id AND wo.expires_at > $2 ORDER BY wo.created_at DESC LIMIT 1) o ON true
          WHERE e.status = 'waiting' AND ($1::uuid[] IS NULL OR e.staff_id = ANY($1))
          ORDER BY e.staff_id, e.created_at`,
        [staffIds, now],
      );
      return rows.rows.map((r) => ({
        id: r.id,
        staffId: r.staff_id,
        staffName: r.staff_name,
        clientId: r.client_id,
        clientName: r.client_name,
        serviceName: r.service_name,
        variantName: r.variant_name,
        dateFrom: r.date_from,
        dateTo: r.date_to,
        partOfDay: r.part_of_day,
        createdAt: r.created_at,
        offer: r.offer_starts && r.offer_expires ? { startsAt: r.offer_starts, expiresAt: r.offer_expires } : null,
      }));
    });
  }

  /** Мастер убирает клиента из очереди. staff — только из очереди своих специалистов. */
  async remove(accountId: string, entryId: string, staffIds: string[] | null): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const updated = await client.query(
        `UPDATE waitlist_entries SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND status = 'waiting' AND ($2::uuid[] IS NULL OR staff_id = ANY($2))`,
        [entryId, staffIds],
      );
      if (updated.rowCount === 0) throw new NotFoundError('waitlist entry');
    });
  }

  /** Ссылка клиента на его место в очереди. */
  link(accountId: string, entryId: string): string {
    return this.tokens.issueWaitlist(accountId, entryId);
  }
}

async function activeOffer(client: PoolClient, entryId: string, now: Date): Promise<{ startsAt: Date; expiresAt: Date } | null> {
  const row = (await client.query<{ starts_at: Date; expires_at: Date }>(
    'SELECT starts_at, expires_at FROM waitlist_offers WHERE entry_id = $1 AND expires_at > $2 ORDER BY created_at DESC LIMIT 1',
    [entryId, now],
  )).rows[0];
  return row ? { startsAt: row.starts_at, expiresAt: row.expires_at } : null;
}

/** Проверка периода при постановке: с сегодня (по поясу Account), не дальше горизонта записи, не длиннее 31 дня. */
export function checkPeriod(dateFrom: string, dateTo: string, today: string, horizonDays: number): Record<string, string> | null {
  if (dateFrom < today) return { dateFrom: 'must not be in the past' };
  if (dateTo < dateFrom) return { dateTo: 'must not be before dateFrom' };
  if (addDays(dateFrom, 30) < dateTo) return { dateTo: 'at most 31 days' };
  if (dateTo > addDays(today, horizonDays)) return { dateTo: 'beyond the booking horizon' };
  return null;
}
