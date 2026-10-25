import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { isLocale, type Locale } from '@rezerwapp/shared';
import type { Pool, PoolClient } from 'pg';
import type { PhoneHasher } from '../crypto/phone-hash';
import type { Db } from '../db/db';
import { AppError, NotFoundError, ValidationError } from '../errors';

/** Документы, которые owner принимает от имени Account (L-10, L-11, L-12). */
export const PLATFORM_DOCUMENTS = ['platform_terms', 'dpa', 'platform_privacy'] as const;
export type PlatformDocument = (typeof PLATFORM_DOCUMENTS)[number];
/** Документы для клиента, показываются на странице специалиста (L-20, L-21, L-23, L-24). */
export const CLIENT_DOCUMENTS = ['terms', 'privacy', 'health', 'marketing'] as const;
export type ClientDocument = (typeof CLIENT_DOCUMENTS)[number];
const ALL_DOCUMENTS: readonly string[] = [...CLIENT_DOCUMENTS, ...PLATFORM_DOCUMENTS];

export interface PendingDocument {
  type: PlatformDocument;
  version: string;
}

/** Кабинет закрыт, пока owner не примет текущие версии документов платформы (D-055). */
export class AcceptanceRequiredError extends AppError {
  constructor(documents: PendingDocument[]) {
    super('ACCEPTANCE_REQUIRED', 'Current platform documents must be accepted by the account owner', { documents });
  }
}

/**
 * Текущие версии документов платформы, ещё не принятые Account. Текущая версия: последняя опубликованная
 * польская (польская обязательна и юридически приоритетна). Вызывается в транзакции withAccount.
 */
export async function pendingPlatformDocuments(client: PoolClient): Promise<PendingDocument[]> {
  const rows = await client.query<PendingDocument>(
    `SELECT d.type, d.version
       FROM (SELECT DISTINCT ON (type) type, version FROM consent_documents
              WHERE type = ANY($1) AND language = 'pl' AND valid_from <= now()
              ORDER BY type, valid_from DESC, version DESC) d
      WHERE NOT EXISTS (SELECT 1 FROM platform_acceptances a WHERE a.document_type = d.type AND a.version = d.version)
      ORDER BY d.type`,
    [PLATFORM_DOCUMENTS],
  );
  return rows.rows;
}

/**
 * Юридические документы (D-055): тексты в consent_documents, принятие документов платформы owner'ом,
 * клиентские документы на странице специалиста с подстановкой названия и имени.
 */
export class LegalService {
  constructor(
    private readonly db: Db,
    /** HMAC адреса для доказательства принятия; тот же секрет, что и для телефонов (D-042). */
    private readonly hasher: PhoneHasher,
  ) {}

  async pending(accountId: string): Promise<PendingDocument[]> {
    return this.db.withAccount(accountId, (client) => pendingPlatformDocuments(client));
  }

  /** Текущие документы платформы на языке Account (иначе польские) и отметка, приняты ли они. */
  async platformDocuments(accountId: string) {
    return this.db.withAccount(accountId, async (client) => {
      const locale = (await client.query<{ locale: string }>('SELECT locale FROM accounts')).rows[0]?.locale ?? 'pl';
      const pending = new Set((await pendingPlatformDocuments(client)).map((d) => d.type));
      const docs = await client.query<{ type: PlatformDocument; version: string; language: Locale; body: string }>(
        `WITH current AS (
           SELECT DISTINCT ON (type) type, version FROM consent_documents
            WHERE type = ANY($1) AND language = 'pl' AND valid_from <= now()
            ORDER BY type, valid_from DESC, version DESC
         )
         SELECT DISTINCT ON (d.type) d.type, d.version, d.language, d.body
           FROM consent_documents d JOIN current c ON c.type = d.type AND c.version = d.version
          WHERE d.language IN ($2, 'pl')
          ORDER BY d.type, (d.language = $2) DESC`,
        [PLATFORM_DOCUMENTS, locale],
      );
      return docs.rows.map((d) => ({ ...d, accepted: !pending.has(d.type) }));
    });
  }

  /** owner принимает текущие версии. Принимать можно только то, что сейчас актуально (защита от устаревшей формы). */
  async accept(accountId: string, userId: string, items: PendingDocument[], ip: string): Promise<PendingDocument[]> {
    return this.db.withAccount(accountId, async (client) => {
      const current = await client.query<PendingDocument & { language: Locale }>(
        `SELECT DISTINCT ON (type) type, version, 'pl' AS language FROM consent_documents
          WHERE type = ANY($1) AND language = 'pl' AND valid_from <= now()
          ORDER BY type, valid_from DESC, version DESC`,
        [PLATFORM_DOCUMENTS],
      );
      const locale = (await client.query<{ locale: string }>('SELECT locale FROM accounts')).rows[0]?.locale ?? 'pl';
      for (const item of items) {
        const match = current.rows.find((c) => c.type === item.type && c.version === item.version);
        if (!match) throw new ValidationError({ [item.type]: `version ${item.version} is not current` });
        await client.query(
          `INSERT INTO platform_acceptances (account_id, user_id, document_type, version, language, ip_hash)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (account_id, document_type, version) DO NOTHING`,
          [accountId, userId, item.type, item.version, isLocale(locale) ? locale : 'pl', this.hasher.hash(ip)],
        );
      }
      return pendingPlatformDocuments(client);
    });
  }

  /** Клиентский документ специалиста (без входа): подстановка {{business_name}} и {{staff_name}}. */
  async publicDocument(slug: string, type: ClientDocument, language: Locale) {
    const ref = (await this.db.pool.query<{ account_id: string; staff_id: string }>('SELECT * FROM public_find_staff($1)', [slug])).rows[0];
    if (!ref) throw new NotFoundError('staff');
    return this.db.withAccount(ref.account_id, async (client) => {
      const names = (await client.query<{ business: string; staff: string }>(
        'SELECT a.name AS business, s.display_name AS staff FROM staff s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1',
        [ref.staff_id],
      )).rows[0]!;
      const doc = (await client.query<{ version: string; language: Locale; body: string }>(
        `SELECT version, language, body FROM consent_documents
          WHERE type = $1 AND language IN ($2, 'pl') AND valid_from <= now()
          ORDER BY (language = $2) DESC, valid_from DESC LIMIT 1`,
        [type, language],
      )).rows[0];
      if (!doc) throw new NotFoundError('document');
      const body = doc.body.replace(/\{\{business_name\}\}/g, names.business).replace(/\{\{staff_name\}\}/g, names.staff);
      return { type, version: doc.version, language: doc.language, body };
    });
  }
}

export interface PublishResult {
  published: Array<{ type: string; language: string }>;
  unchanged: Array<{ type: string; language: string }>;
}

/** Папка legal/ вверх от текущего файла (работает из src/, dist/ и .test-dist/). */
export function findLegalDir(start: string = __dirname): string {
  let dir = start;
  for (let i = 0; i < 7; i += 1) {
    const candidate = path.join(dir, 'legal');
    if (existsSync(path.join(candidate, 'README.md'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('legal directory not found');
}

/**
 * Публикует тексты из legal/<тип>/<язык>.md как версию version (ролью-мигратором: приложению запись
 * в consent_documents запрещена). Новая версия создаётся только для документов, текст которых отличается
 * от последней опубликованной версии. Опубликованная версия неизменна: другой текст под той же версией =
 * ошибка. Всё в одной транзакции.
 */
export async function publishLegal(pool: Pool, version: string, dir: string = findLegalDir()): Promise<PublishResult> {
  if (!/^[\w.-]{1,40}$/.test(version)) throw new Error('version: letters, digits, dot, dash, underscore, up to 40');
  const files: Array<{ type: string; language: string; body: string }> = [];
  for (const type of readdirSync(dir)) {
    if (!ALL_DOCUMENTS.includes(type)) continue;
    for (const file of readdirSync(path.join(dir, type))) {
      const language = file.replace(/\.md$/, '');
      if (!file.endsWith('.md') || !isLocale(language)) continue;
      files.push({ type, language, body: readFileSync(path.join(dir, type, file), 'utf8').replace(/\r\n/g, '\n').trim() });
    }
  }
  const result: PublishResult = { published: [], unchanged: [] };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const f of files) {
      const existing = (await client.query<{ body: string }>(
        'SELECT body FROM consent_documents WHERE type = $1 AND language = $2 AND version = $3',
        [f.type, f.language, version],
      )).rows[0];
      if (existing) {
        if (existing.body !== f.body) throw new Error(`${f.type}/${f.language} version ${version} is already published with a different text`);
        result.unchanged.push({ type: f.type, language: f.language });
        continue;
      }
      // Текст не менялся с последней опубликованной версии: новая версия не создаётся, иначе owner
      // заново принимал бы документ, который не изменился.
      const latest = (await client.query<{ body: string }>(
        'SELECT body FROM consent_documents WHERE type = $1 AND language = $2 ORDER BY valid_from DESC, version DESC LIMIT 1',
        [f.type, f.language],
      )).rows[0];
      if (latest?.body === f.body) {
        result.unchanged.push({ type: f.type, language: f.language });
        continue;
      }
      await client.query('INSERT INTO consent_documents (type, language, version, body) VALUES ($1, $2, $3, $4)', [f.type, f.language, version, f.body]);
      result.published.push({ type: f.type, language: f.language });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return result;
}
