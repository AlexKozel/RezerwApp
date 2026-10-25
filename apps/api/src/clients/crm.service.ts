import { randomBytes } from 'node:crypto';
import type { Locale } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import { audit } from '../audit';
import type { FieldCipher } from '../crypto/field-cipher';
import type { PhoneHasher } from '../crypto/phone-hash';
import type { Db } from '../db/db';
import { AppError, ConflictError, NotFoundError } from '../errors';
import type { ClientsService } from './clients.service';

/**
 * Кто смотрит: пользователь и специалисты, к которым он ограничен (null = все, роли owner и assistant).
 * «Свои» клиенты специалиста: те, у кого есть хотя бы одна запись к нему (D-050).
 */
export interface Viewer {
  accountId: string;
  userId: string;
  staffIds: string[] | null;
}

export interface ClientSummary {
  id: string;
  name: string;
  language: Locale;
  createdAt: Date;
  anonymized: boolean;
}

export interface ClientCard extends ClientSummary {
  phone: string | null;
  email: string | null;
  blacklisted: { reason: string | null; expiresAt: Date } | null;
  stats: { completed: number; noShow: number; cancelledByClient: number };
  bookings: Array<{ id: string; staffId: string; startsAt: Date; status: string }>;
  consents: Array<{ type: string; textVersion: string; givenAt: Date; revokedAt: Date | null }>;
}

export interface Note {
  id: string;
  body: string;
  sensitivity: 'normal' | 'health';
  createdAt: Date;
}

/** D-024: срок хранения записи blacklist по умолчанию. */
export const BLACKLIST_DEFAULT_DAYS = 730;
const LIST_LIMIT = 50;

export class ClientExistsError extends ConflictError {
  constructor(clientId: string) {
    super('CLIENT_EXISTS', 'A client with this phone already exists', { clientId });
  }
}

export class HealthConsentRequiredError extends AppError {
  constructor() {
    super('HEALTH_CONSENT_REQUIRED', 'Client has not consented to processing health data');
  }
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  // Защита от формул в Excel/Sheets: значение, начинающееся с = + - @, открывается как текст.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: Array<Record<string, unknown>>, columns: string[]): string {
  return [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
}

/**
 * CRM мастера (D-020, D-022, D-024, D-025, D-050): поиск и карточка клиента, заметки, blacklist, экспорт,
 * анонимизация по запросу клиента. Телефон и заметки расшифровываются только здесь и каждое чтение
 * журналируется в audit_log в той же транзакции.
 */
export class CrmService {
  constructor(
    private readonly db: Db,
    private readonly clients: ClientsService,
    private readonly hasher: PhoneHasher,
    private readonly cipher: FieldCipher,
  ) {}

  /** Поиск: номер телефона ищется точно по HMAC, иначе подстрока имени. */
  async list(viewer: Viewer, query: { search?: string; offset?: number }): Promise<ClientSummary[]> {
    return this.db.withAccount(viewer.accountId, async (client) => {
      const phone = query.search ? this.hasher.hashInput(query.search) : null;
      const namePattern = query.search && !phone ? `%${query.search.toLowerCase().replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
      const rows = await client.query<{ id: string; name: string; language: Locale; created_at: Date; anonymized_at: Date | null }>(
        `SELECT c.id, c.name, c.language, c.created_at, c.anonymized_at FROM clients c
          WHERE ($1::bytea IS NULL OR c.phone_hash = $1)
            AND ($2::text IS NULL OR lower(c.name) LIKE $2)
            AND ($3::uuid[] IS NULL OR EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.staff_id = ANY($3)))
          ORDER BY lower(c.name), c.id
          LIMIT $4 OFFSET $5`,
        [phone?.hash ?? null, namePattern, viewer.staffIds, LIST_LIMIT, query.offset ?? 0],
      );
      return rows.rows.map((r) => ({ id: r.id, name: r.name, language: r.language, createdAt: r.created_at, anonymized: r.anonymized_at !== null }));
    });
  }

  /** Клиент, добавленный мастером вручную. Если номер уже есть в базе, возвращается CLIENT_EXISTS с id. */
  async create(viewer: Viewer, input: { name: string; phone: string; language: Locale; email: string | null }): Promise<{ id: string }> {
    return this.db.withAccount(viewer.accountId, async (client) => {
      const ref = await this.clients.findOrCreate(client, viewer.accountId, input);
      if (!ref.created) throw new ClientExistsError(ref.id);
      if (input.email) await client.query('UPDATE clients SET email = $2 WHERE id = $1', [ref.id, input.email]);
      return { id: ref.id };
    });
  }

  async card(viewer: Viewer, clientId: string): Promise<ClientCard> {
    return this.db.withAccount(viewer.accountId, async (client) => {
      const row = await this.visible(client, viewer, clientId);
      const phone = row.anonymized_at ? null : await this.cipher.decrypt(client, viewer.accountId, row.phone_encrypted);
      await audit(client, viewer.accountId, viewer.userId, 'client.read', 'client', clientId);

      const blacklist = (await client.query<{ reason: string | null; expires_at: Date }>(
        'SELECT reason, expires_at FROM blacklist_entries WHERE phone_hash = $1 AND expires_at > now()',
        [row.phone_hash],
      )).rows[0];
      const bookings = await client.query<{ id: string; staff_id: string; starts_at: Date; status: string }>(
        `SELECT id, staff_id, starts_at, status FROM bookings
          WHERE client_id = $1 AND ($2::uuid[] IS NULL OR staff_id = ANY($2))
          ORDER BY starts_at DESC LIMIT 100`,
        [clientId, viewer.staffIds],
      );
      const count = (status: string) => bookings.rows.filter((b) => b.status === status).length;
      const consents = await client.query<{ type: string; text_version: string; given_at: Date; revoked_at: Date | null }>(
        'SELECT type, text_version, given_at, revoked_at FROM consents WHERE client_id = $1 ORDER BY given_at DESC',
        [clientId],
      );
      return {
        id: row.id,
        name: row.name,
        language: row.language,
        createdAt: row.created_at,
        anonymized: row.anonymized_at !== null,
        phone,
        email: row.email,
        blacklisted: blacklist ? { reason: blacklist.reason, expiresAt: blacklist.expires_at } : null,
        stats: { completed: count('completed'), noShow: count('no_show'), cancelledByClient: count('cancelled_by_client') },
        bookings: bookings.rows.map((b) => ({ id: b.id, staffId: b.staff_id, startsAt: b.starts_at, status: b.status })),
        consents: consents.rows.map((c) => ({ type: c.type, textVersion: c.text_version, givenAt: c.given_at, revokedAt: c.revoked_at })),
      };
    });
  }

  async update(viewer: Viewer, clientId: string, patch: { name?: string; email?: string | null; language?: Locale }): Promise<void> {
    await this.db.withAccount(viewer.accountId, async (client) => {
      const row = await this.visible(client, viewer, clientId);
      if (row.anonymized_at) throw new ConflictError('CLIENT_ANONYMIZED', 'Client data was erased');
      await client.query(
        `UPDATE clients SET name = COALESCE($2, name), email = CASE WHEN $3 THEN $4 ELSE email END, language = COALESCE($5, language)
          WHERE id = $1`,
        [clientId, patch.name ?? null, patch.email !== undefined, patch.email ?? null, patch.language ?? null],
      );
    });
  }

  // --- Заметки (D-025) ---

  async notes(viewer: Viewer, clientId: string): Promise<Note[]> {
    return this.db.withAccount(viewer.accountId, async (client) => {
      await this.visible(client, viewer, clientId);
      const rows = await client.query<{ id: string; body_encrypted: Buffer; sensitivity: Note['sensitivity']; created_at: Date }>(
        'SELECT id, body_encrypted, sensitivity, created_at FROM client_notes WHERE client_id = $1 ORDER BY created_at DESC',
        [clientId],
      );
      await audit(client, viewer.accountId, viewer.userId, 'notes.read', 'client', clientId);
      const notes: Note[] = [];
      for (const r of rows.rows) {
        notes.push({ id: r.id, body: await this.cipher.decrypt(client, viewer.accountId, r.body_encrypted), sensitivity: r.sensitivity, createdAt: r.created_at });
      }
      return notes;
    });
  }

  /** Заметка о здоровье только при действующем согласии клиента (D-025, L-23). */
  async addNote(viewer: Viewer, clientId: string, body: string, sensitivity: Note['sensitivity']): Promise<{ id: string }> {
    return this.db.withAccount(viewer.accountId, async (client) => {
      const row = await this.visible(client, viewer, clientId);
      if (row.anonymized_at) throw new ConflictError('CLIENT_ANONYMIZED', 'Client data was erased');
      if (sensitivity === 'health') {
        const consent = await client.query("SELECT 1 FROM consents WHERE client_id = $1 AND type = 'health' AND revoked_at IS NULL", [clientId]);
        if (consent.rowCount === 0) throw new HealthConsentRequiredError();
      }
      const encrypted = await this.cipher.encrypt(client, viewer.accountId, body);
      const inserted = await client.query<{ id: string }>(
        'INSERT INTO client_notes (account_id, client_id, body_encrypted, sensitivity) VALUES ($1, $2, $3, $4) RETURNING id',
        [viewer.accountId, clientId, encrypted, sensitivity],
      );
      await audit(client, viewer.accountId, viewer.userId, 'notes.write', 'client', clientId);
      return { id: inserted.rows[0]!.id };
    });
  }

  async deleteNote(viewer: Viewer, clientId: string, noteId: string): Promise<void> {
    await this.db.withAccount(viewer.accountId, async (client) => {
      await this.visible(client, viewer, clientId);
      const deleted = await client.query('DELETE FROM client_notes WHERE id = $1 AND client_id = $2', [noteId, clientId]);
      if (deleted.rowCount === 0) throw new NotFoundError('note');
      await audit(client, viewer.accountId, viewer.userId, 'notes.delete', 'client', clientId);
    });
  }

  // --- Blacklist (D-024) ---

  async blacklist(viewer: Viewer, clientId: string, reason: string | null, days = BLACKLIST_DEFAULT_DAYS): Promise<{ expiresAt: Date }> {
    return this.db.withAccount(viewer.accountId, async (client) => {
      const row = await this.visible(client, viewer, clientId);
      if (row.anonymized_at) throw new ConflictError('CLIENT_ANONYMIZED', 'Client data was erased');
      const entry = await client.query<{ expires_at: Date }>(
        `INSERT INTO blacklist_entries (account_id, phone_hash, reason, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4::int))
         ON CONFLICT (account_id, phone_hash) DO UPDATE SET reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at
         RETURNING expires_at`,
        [viewer.accountId, row.phone_hash, reason, days],
      );
      await audit(client, viewer.accountId, viewer.userId, 'blacklist.add', 'client', clientId);
      return { expiresAt: entry.rows[0]!.expires_at };
    });
  }

  async unblacklist(viewer: Viewer, clientId: string): Promise<void> {
    await this.db.withAccount(viewer.accountId, async (client) => {
      const row = await this.visible(client, viewer, clientId);
      const deleted = await client.query('DELETE FROM blacklist_entries WHERE phone_hash = $1', [row.phone_hash]);
      if (deleted.rowCount === 0) throw new NotFoundError('blacklist entry');
      await audit(client, viewer.accountId, viewer.userId, 'blacklist.remove', 'client', clientId);
    });
  }

  /** Фоновая задача: удаляет записи blacklist с истёкшим сроком (D-024). */
  async purgeExpiredBlacklist(accountId: string): Promise<number> {
    return this.db.withAccount(accountId, async (client) => {
      const deleted = await client.query('DELETE FROM blacklist_entries WHERE expires_at <= now()');
      return deleted.rowCount ?? 0;
    });
  }

  // --- Экспорт и удаление (D-022, DATA_MODEL.md, разделы 5-6) ---

  /** Полная выгрузка базы Account: клиенты (с телефоном), записи, согласия. Заметки не выгружаются. */
  async export(viewer: Viewer) {
    return this.db.withAccount(viewer.accountId, async (client) => {
      const clients = await client.query<{
        id: string;
        name: string;
        phone_encrypted: Buffer;
        email: string | null;
        language: string;
        created_at: Date;
        anonymized_at: Date | null;
      }>('SELECT id, name, phone_encrypted, email, language, created_at, anonymized_at FROM clients ORDER BY created_at');
      const rows = [];
      for (const c of clients.rows) {
        rows.push({
          id: c.id,
          name: c.name,
          phone: c.anonymized_at ? null : await this.cipher.decrypt(client, viewer.accountId, c.phone_encrypted),
          email: c.email,
          language: c.language,
          createdAt: c.created_at,
          anonymizedAt: c.anonymized_at,
        });
      }
      const bookings = await client.query(
        `SELECT id, client_id AS "clientId", staff_id AS "staffId", service_id AS "serviceId", starts_at AS "startsAt",
                ends_at AS "endsAt", status, created_at AS "createdAt"
           FROM bookings ORDER BY starts_at`,
      );
      const consents = await client.query(
        `SELECT client_id AS "clientId", type, text_version AS "textVersion", given_at AS "givenAt", revoked_at AS "revokedAt"
           FROM consents ORDER BY given_at`,
      );
      await audit(client, viewer.accountId, viewer.userId, 'clients.export');
      return { clients: rows, bookings: bookings.rows, consents: consents.rows };
    });
  }

  /**
   * Удаление по запросу клиента (RODO, L-43): персональные данные стираются, записи остаются для учёта
   * мастера, согласия остаются как доказательство. phone_hash заменяется случайным: клиент больше не
   * находится по номеру, и запись с того же номера создаст новую карточку.
   */
  async anonymize(viewer: Viewer, clientId: string): Promise<void> {
    await this.db.withAccount(viewer.accountId, async (client) => {
      const row = await this.visible(client, viewer, clientId);
      if (row.anonymized_at) return;
      await client.query('DELETE FROM client_notes WHERE client_id = $1', [clientId]);
      await client.query('DELETE FROM blacklist_entries WHERE phone_hash = $1', [row.phone_hash]);
      await client.query(
        `UPDATE clients SET name = '—', email = NULL, phone_encrypted = '\\x'::bytea, phone_hash = $2, anonymized_at = now()
          WHERE id = $1`,
        [clientId, randomBytes(32)],
      );
      await audit(client, viewer.accountId, viewer.userId, 'client.anonymize', 'client', clientId);
    });
  }

  async auditLog(viewer: Viewer, offset = 0) {
    return this.db.withAccount(viewer.accountId, async (client) => {
      const rows = await client.query(
        `SELECT a.at, a.action, a.object_type AS "objectType", a.object_id AS "objectId", a.actor_id AS "actorId", u.email AS "actorEmail"
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
          ORDER BY a.at DESC, a.id DESC LIMIT 100 OFFSET $1`,
        [offset],
      );
      return rows.rows;
    });
  }

  /** Клиент, видимый этому пользователю; иначе NOT_FOUND (не раскрываем, что клиент существует). */
  private async visible(client: PoolClient, viewer: Viewer, clientId: string) {
    const row = (await client.query<{
      id: string;
      name: string;
      language: Locale;
      email: string | null;
      phone_encrypted: Buffer;
      phone_hash: Buffer;
      created_at: Date;
      anonymized_at: Date | null;
    }>(
      `SELECT c.* FROM clients c
        WHERE c.id = $1
          AND ($2::uuid[] IS NULL OR EXISTS (SELECT 1 FROM bookings b WHERE b.client_id = c.id AND b.staff_id = ANY($2)))
        FOR UPDATE OF c`,
      [clientId, viewer.staffIds],
    )).rows[0];
    if (!row) throw new NotFoundError('client');
    return row;
  }
}

