import type { PoolClient } from 'pg';
import { SLUG_RE } from '../catalog/catalog.service';
import { SignedTokens, bytesToUuid, uuidToBytes } from '../crypto/signed-token';
import type { Db } from '../db/db';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../errors';

/** Срок приглашения Independent-мастера. */
export const INVITE_TTL_DAYS = 7;
/** Максимальный диапазон общего календаря (как в функции location_busy). */
export const CALENDAR_MAX_DAYS = 62;

export interface Location {
  id: string;
  name: string;
  address: string | null;
  publicSlug: string;
}

export interface Membership {
  id: string;
  side: 'salon' | 'member';
  locationId: string;
  locationName: string;
  locationSlug: string;
  salonName: string;
  memberAccountId: string;
  memberName: string;
  status: 'invited' | 'active' | 'ended';
  startedAt: Date | null;
  endedAt: Date | null;
}

export class InviteInvalidError extends AppError {
  constructor() {
    super('INVITE_INVALID', 'Invitation is invalid or expired');
  }
}

/**
 * Приглашение в Location: подписанный токен с Location, Account салона и сроком. Подписан ключом, которого нет
 * у мастера, поэтому подделать его или продлить нельзя; в БД не хранится.
 */
export class InviteTokens {
  private readonly tokens: SignedTokens;

  constructor(masterKey: Buffer) {
    this.tokens = new SignedTokens(masterKey, 'location-invite-v1');
  }

  issue(locationId: string, salonAccountId: string, expiresAt: Date): string {
    const exp = Buffer.alloc(4);
    exp.writeUInt32BE(Math.floor(expiresAt.getTime() / 1000));
    return this.tokens.sign(Buffer.concat([uuidToBytes(locationId), uuidToBytes(salonAccountId), exp]));
  }

  open(token: string, now = new Date()): { locationId: string; salonAccountId: string } | null {
    const payload = this.tokens.open(token);
    if (!payload || payload.length !== 36) return null;
    if (payload.readUInt32BE(32) * 1000 < now.getTime()) return null;
    return { locationId: bytesToUuid(payload.subarray(0, 16)), salonAccountId: bytesToUuid(payload.subarray(16, 32)) };
  }
}

/**
 * Салоны (D-021, D-022, D-053). Location и Employee-специалисты принадлежат Account салона. Independent-мастер
 * со своим Account подключается сам, принимая приглашение; салон видит у него только занятость (location_busy).
 * Уход мастера = завершение подключения; его Account, клиенты и история не затрагиваются.
 */
export class LocationsService {
  constructor(
    private readonly db: Db,
    private readonly invites: InviteTokens,
  ) {}

  async create(accountId: string, input: { name: string; address: string | null; publicSlug: string }): Promise<Location> {
    if (!SLUG_RE.test(input.publicSlug)) throw new ValidationError({ publicSlug: 'a-z, 0-9 and hyphens, 3-40 characters' });
    try {
      return await this.db.withAccount(accountId, async (client) => {
        const row = await client.query<{ id: string }>(
          'INSERT INTO locations (account_id, name, address, public_slug) VALUES ($1, $2, $3, $4) RETURNING id',
          [accountId, input.name, input.address, input.publicSlug],
        );
        return { id: row.rows[0]!.id, ...input };
      });
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'locations_public_slug_key') throw new ConflictError('SLUG_TAKEN', 'Public link is taken');
      throw error;
    }
  }

  async list(accountId: string): Promise<Location[]> {
    return this.db.withAccount(accountId, async (client) => {
      const rows = await client.query<{ id: string; name: string; address: string | null; public_slug: string }>(
        'SELECT id, name, address, public_slug FROM locations ORDER BY created_at',
      );
      return rows.rows.map((r) => ({ id: r.id, name: r.name, address: r.address, publicSlug: r.public_slug }));
    });
  }

  async update(accountId: string, locationId: string, patch: { name?: string; address?: string | null }): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const updated = await client.query(
        'UPDATE locations SET name = COALESCE($2, name), address = CASE WHEN $3 THEN $4 ELSE address END WHERE id = $1',
        [locationId, patch.name ?? null, patch.address !== undefined, patch.address ?? null],
      );
      if (updated.rowCount === 0) throw new NotFoundError('location');
    });
  }

  /** Employee: специалист салона работает в этой Location (null = без адреса). */
  async assignStaff(accountId: string, staffId: string, locationId: string | null): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      if (locationId) await this.requireLocation(client, locationId);
      const updated = await client.query('UPDATE staff SET location_id = $2 WHERE id = $1', [staffId, locationId]);
      if (updated.rowCount === 0) throw new NotFoundError('staff');
    });
  }

  async invite(accountId: string, locationId: string, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
    await this.db.withAccount(accountId, (client) => this.requireLocation(client, locationId));
    const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 3_600_000);
    return { token: this.invites.issue(locationId, accountId, expiresAt), expiresAt };
  }

  /**
   * Мастер принимает приглашение своим Account. Повторное принятие после ухода возвращает подключение в active.
   * RLS и триггер (миграция 0009) не дают салону создать или активировать подключение за мастера.
   */
  async accept(memberAccountId: string, token: string): Promise<Membership> {
    const invite = this.invites.open(token);
    if (!invite) throw new InviteInvalidError();
    if (invite.salonAccountId === memberAccountId) throw new ConflictError('OWN_LOCATION', 'Cannot join your own location');
    try {
      await this.db.withAccount(memberAccountId, async (client) => {
        await client.query(
          `INSERT INTO location_memberships (location_id, location_account_id, member_account_id, status, started_at)
           VALUES ($1, $2, $3, 'active', now())
           ON CONFLICT (location_id, member_account_id)
           DO UPDATE SET status = 'active', started_at = now(), ended_at = NULL
           WHERE location_memberships.status <> 'active'`,
          [invite.locationId, invite.salonAccountId, memberAccountId],
        );
      });
    } catch (error) {
      // Location удалена после выдачи приглашения.
      if ((error as { code?: string }).code === '23503') throw new InviteInvalidError();
      throw error;
    }
    const membership = (await this.memberships(memberAccountId)).find((m) => m.locationId === invite.locationId && m.side === 'member');
    if (!membership) throw new Error('membership not visible after accept');
    return membership;
  }

  /** Завершить подключение может любая сторона (уход мастера или отключение салоном, D-022). */
  async end(accountId: string, membershipId: string): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const updated = await client.query(
        "UPDATE location_memberships SET status = 'ended', ended_at = now() WHERE id = $1 AND status = 'active'",
        [membershipId],
      );
      if (updated.rowCount === 0) throw new NotFoundError('active membership');
    });
  }

  async memberships(accountId: string): Promise<Membership[]> {
    return this.db.withAccount(accountId, async (client) => {
      const rows = await client.query<{
        id: string;
        side: Membership['side'];
        location_id: string;
        location_name: string;
        location_slug: string;
        salon_name: string;
        member_account_id: string;
        member_name: string;
        status: Membership['status'];
        started_at: Date | null;
        ended_at: Date | null;
      }>('SELECT * FROM my_memberships()');
      return rows.rows.map((r) => ({
        id: r.id,
        side: r.side,
        locationId: r.location_id,
        locationName: r.location_name,
        locationSlug: r.location_slug,
        salonName: r.salon_name,
        memberAccountId: r.member_account_id,
        memberName: r.member_name,
        status: r.status,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      }));
    });
  }

  /**
   * Общий календарь Location (D-021): свои специалисты этой Location с записями (без клиентов) и подключённые
   * мастера только как занятость. Итог по занятым минутам на мастера: данные для расчёта аренды.
   */
  async calendar(accountId: string, locationId: string, from: Date, to: Date) {
    if (!(from < to) || to.getTime() - from.getTime() > CALENDAR_MAX_DAYS * 24 * 3_600_000) {
      throw new ValidationError({ to: `after from, at most ${CALENDAR_MAX_DAYS} days` });
    }
    return this.db.withAccount(accountId, async (client) => {
      await this.requireLocation(client, locationId);
      const own = await client.query<{ staff_id: string; staff_name: string; starts_at: Date; ends_at: Date; status: string }>(
        `SELECT s.id AS staff_id, s.display_name AS staff_name, lower(b.slot) AS starts_at, upper(b.slot) AS ends_at, b.status
           FROM bookings b JOIN staff s ON s.id = b.staff_id
          WHERE s.location_id = $1 AND b.slot && tstzrange($2::timestamptz, $3::timestamptz)
            AND (b.status = 'confirmed' OR (b.status = 'pending' AND b.hold_expires_at > now()))
          ORDER BY 3`,
        [locationId, from, to],
      );
      const members = await client.query<{ member_account_id: string; staff_id: string; staff_name: string; starts_at: Date; ends_at: Date }>(
        'SELECT * FROM location_busy($1, $2, $3)',
        [locationId, from, to],
      );
      const minutes = new Map<string, number>();
      for (const m of members.rows) {
        // Учитываем только часть интервала внутри запрошенного периода.
        const start = Math.max(m.starts_at.getTime(), from.getTime());
        const end = Math.min(m.ends_at.getTime(), to.getTime());
        minutes.set(m.member_account_id, (minutes.get(m.member_account_id) ?? 0) + Math.max(0, end - start) / 60_000);
      }
      return {
        employees: own.rows.map((r) => ({ staffId: r.staff_id, staffName: r.staff_name, startsAt: r.starts_at, endsAt: r.ends_at, status: r.status })),
        independents: members.rows.map((r) => ({ memberAccountId: r.member_account_id, staffId: r.staff_id, staffName: r.staff_name, startsAt: r.starts_at, endsAt: r.ends_at })),
        busyMinutesByMember: Object.fromEntries(minutes),
      };
    });
  }

  /** Studio page: салон, адрес и мастера (Employee и активные Independent) со ссылками на их страницы записи. */
  async publicPage(slug: string) {
    const rows = await this.db.pool.query<{
      location_id: string;
      name: string;
      address: string | null;
      staff_name: string | null;
      staff_slug: string | null;
      independent: boolean | null;
    }>('SELECT * FROM public_location($1)', [slug]);
    const first = rows.rows[0];
    if (!first) throw new NotFoundError('location');
    return {
      name: first.name,
      address: first.address,
      staff: rows.rows.filter((r) => r.staff_slug).map((r) => ({ displayName: r.staff_name!, publicSlug: r.staff_slug!, independent: r.independent! })),
    };
  }

  private async requireLocation(client: PoolClient, locationId: string): Promise<void> {
    const found = await client.query('SELECT 1 FROM locations WHERE id = $1', [locationId]);
    if (found.rowCount === 0) throw new NotFoundError('location');
  }
}
