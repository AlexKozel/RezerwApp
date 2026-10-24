import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { migrate } from '../src/db/migrate';
import { createTestDb, type TestDb } from './helpers/test-db';

describe('migrate', () => {
  let db: TestDb;

  before(async () => {
    db = await createTestDb('migrate');
  });
  after(async () => {
    await db.close();
  });

  test('повторный запуск ничего не применяет', async () => {
    const again = await migrate(db.admin as Pool);
    assert.deepEqual(again, []);
  });

  test('применённые миграции записаны, служебная таблица недоступна приложению', async () => {
    const rows = await db.admin.query('SELECT name FROM schema_migrations ORDER BY name');
    assert.ok(rows.rows.length >= 1);
    assert.equal(rows.rows[0].name, '0001_init.sql');
    await assert.rejects(db.app.pool.query('SELECT * FROM schema_migrations'), /permission denied/);
  });

  test('роль приложения не обходит RLS', async () => {
    const role = await db.admin.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'rezerwapp_app'");
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false });
  });

  test('без контекста Account приложение не видит строк', async () => {
    await db.admin.query("INSERT INTO accounts (name) VALUES ('Hidden')");
    const result = await db.app.pool.query('SELECT count(*)::int AS n FROM accounts');
    assert.equal(result.rows[0].n, 0);
  });
});
