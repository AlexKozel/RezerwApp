import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Db, createPool } from '../../src/db/db';
import { migrate } from '../../src/db/migrate';

const ADMIN_URL = process.env.TEST_PG_ADMIN_URL ?? 'postgres://rezerwapp:rezerwapp@localhost:5432/postgres';

function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

function withCredentials(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
}

export interface TestDb {
  /** Суперпользователь: обходит RLS, нужен для заполнения и проверки данных. */
  admin: Pool;
  /** Роль приложения: подчиняется RLS, как в проде. */
  app: Db;
  close(): Promise<void>;
}

/** Создаёт чистую базу под тестовый файл, применяет миграции, выдаёт логин роли приложения. */
export async function createTestDb(name: string): Promise<TestDb> {
  const database = `rezerwapp_t_${name}`;
  const server = new Pool({ connectionString: ADMIN_URL, max: 1 });
  await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${database}`);
  await server.end();

  const adminUrl = withDatabase(ADMIN_URL, database);
  const admin = new Pool({ connectionString: adminUrl, max: 4 });
  await migrate(admin);
  await admin.query("ALTER ROLE rezerwapp_app LOGIN PASSWORD 'rezerwapp_app'");

  const app = new Db(createPool(withCredentials(adminUrl, 'rezerwapp_app', 'rezerwapp_app'), 20));

  return {
    admin,
    app,
    async close() {
      await app.close();
      await admin.end();
      const cleanup = new Pool({ connectionString: ADMIN_URL, max: 1 });
      await cleanup.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

export interface Seed {
  accountId: string;
  staffId: string;
  clientId: string;
  serviceId: string;
  variantId: string;
  policyId: string;
}

export interface SeedOptions {
  durationMin?: number;
  bufferMin?: number;
  overrideDurationMin?: number | null;
  holdMinutes?: number;
}

/** Account со специалистом, клиентом, услугой с вариантом и политикой (версия 3). */
export async function seedAccount(pool: Pool, options: SeedOptions = {}): Promise<Seed> {
  const s: Seed = {
    accountId: randomUUID(),
    staffId: randomUUID(),
    clientId: randomUUID(),
    serviceId: randomUUID(),
    variantId: randomUUID(),
    policyId: randomUUID(),
  };
  const slug = s.accountId.slice(0, 8);
  await pool.query('INSERT INTO accounts (id, name) VALUES ($1, $2)', [s.accountId, `Account ${slug}`]);
  await pool.query('INSERT INTO policies (id, account_id, version, hold_minutes) VALUES ($1, $2, 3, $3)', [
    s.policyId,
    s.accountId,
    options.holdMinutes ?? 120,
  ]);
  await pool.query('INSERT INTO staff (id, account_id, display_name, public_slug) VALUES ($1, $2, $3, $4)', [
    s.staffId,
    s.accountId,
    'Staff',
    `staff-${slug}`,
  ]);
  await pool.query(
    "INSERT INTO clients (id, account_id, name, phone_encrypted, phone_hash) VALUES ($1, $2, 'Client', '\\x01', $3)",
    [s.clientId, s.accountId, Buffer.from(slug)],
  );
  await pool.query('INSERT INTO services (id, account_id, cancel_policy_id) VALUES ($1, $2, $3)', [
    s.serviceId,
    s.accountId,
    s.policyId,
  ]);
  await pool.query(
    'INSERT INTO service_variants (id, account_id, service_id, duration_min, buffer_min, price) VALUES ($1, $2, $3, $4, $5, 100)',
    [s.variantId, s.accountId, s.serviceId, options.durationMin ?? 60, options.bufferMin ?? 10],
  );
  await pool.query(
    'INSERT INTO staff_services (account_id, staff_id, service_id, override_duration_min) VALUES ($1, $2, $3, $4)',
    [s.accountId, s.staffId, s.serviceId, options.overrideDurationMin ?? null],
  );
  return s;
}

export async function addClient(pool: Pool, accountId: string, tag: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    "INSERT INTO clients (id, account_id, name, phone_encrypted, phone_hash) VALUES ($1, $2, $3, '\\x01', $4)",
    [id, accountId, tag, Buffer.from(tag)],
  );
  return id;
}
