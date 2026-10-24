import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createTestDb, seedAccount, type TestDb } from './helpers/test-db';

describe('поиск до выбора Account (SECURITY DEFINER, миграция 0002)', () => {
  let db: TestDb;
  let accountId: string;

  before(async () => {
    db = await createTestDb('lookup');
    const s = await seedAccount(db.admin);
    accountId = s.accountId;
    await db.admin.query("INSERT INTO users (account_id, email, role, password_hash) VALUES ($1, 'Anna@Example.pl', 'owner', 'h1')", [accountId]);
    await db.admin.query("INSERT INTO users (account_id, email, role) VALUES ($1, 'nopass@example.pl', 'staff')", [accountId]);
  });
  after(async () => {
    await db.close();
  });

  const find = (email: string) => db.app.pool.query('SELECT * FROM auth_find_user($1)', [email]);

  test('роль приложения не читает users напрямую без контекста', async () => {
    const r = await db.app.pool.query('SELECT count(*)::int AS n FROM users');
    assert.equal(r.rows[0].n, 0);
  });

  test('пользователь находится по email без учёта регистра и только с нужными полями', async () => {
    const r = await find('anna@example.PL');
    assert.equal(r.rows.length, 1);
    assert.deepEqual(Object.keys(r.rows[0]).sort(), ['account_id', 'password_hash', 'role', 'user_id']);
    assert.equal(r.rows[0].account_id, accountId);
  });

  test('шаблоны и пустые строки не перебирают пользователей', async () => {
    for (const probe of ['%', '_%', '', '%@example.pl', "' OR 1=1 --"]) {
      assert.equal((await find(probe)).rows.length, 0, probe);
    }
  });

  test('без пароля и в неактивном Account вход невозможен', async () => {
    assert.equal((await find('nopass@example.pl')).rows.length, 0);
    await db.admin.query("UPDATE accounts SET status = 'suspended' WHERE id = $1", [accountId]);
    assert.equal((await find('anna@example.pl')).rows.length, 0);
    await db.admin.query("UPDATE accounts SET status = 'active' WHERE id = $1", [accountId]);
  });

  test('специалист находится по точному slug, неактивный нет', async () => {
    const s = await seedAccount(db.admin);
    const slug = (await db.admin.query('SELECT public_slug FROM staff WHERE id = $1', [s.staffId])).rows[0].public_slug;
    const found = await db.app.pool.query('SELECT * FROM public_find_staff($1)', [slug]);
    assert.deepEqual(found.rows, [{ account_id: s.accountId, staff_id: s.staffId }]);
    assert.equal((await db.app.pool.query('SELECT * FROM public_find_staff($1)', ['%'])).rows.length, 0);
    await db.admin.query('UPDATE staff SET active = false WHERE id = $1', [s.staffId]);
    assert.equal((await db.app.pool.query('SELECT * FROM public_find_staff($1)', [slug])).rows.length, 0);
  });

  test('роль поиска не суперпользователь, без входа и без BYPASSRLS; приложение не может ею стать', async () => {
    const role = await db.admin.query("SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'rezerwapp_lookup'");
    assert.deepEqual(role.rows[0], { rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    await assert.rejects(db.app.pool.query('SET ROLE rezerwapp_lookup'), /permission denied/);
  });

  test('функции закреплены за search_path и недоступны PUBLIC', async () => {
    const fns = await db.admin.query(
      `SELECT p.proname, p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec
         FROM pg_proc p WHERE p.proname IN ('auth_find_user', 'public_find_staff') ORDER BY p.proname`,
    );
    for (const f of fns.rows) {
      assert.equal(f.prosecdef, true, f.proname);
      assert.deepEqual(f.proconfig, ['search_path=pg_catalog, pg_temp'], f.proname);
      assert.equal(f.public_exec, false, f.proname);
    }
  });
});
