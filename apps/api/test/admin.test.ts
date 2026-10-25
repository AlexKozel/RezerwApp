import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { Pool } from 'pg';
import { PlatformAdmin } from '../src/admin/admin';
import { createMaster } from '../src/auth/auth.service';
import { NotFoundError, ValidationError } from '../src/errors';
import { Client, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const ROLE = 'rezerwapp_admin_test';

describe('администрирование платформы (D-057)', () => {
  let db: TestDb;
  let t: TestApp;
  let adminPool: Pool;
  let admin: PlatformAdmin;
  let accountId: string;
  let otherId: string;
  let owner: Client;

  before(async () => {
    db = await createTestDb('admin');
    t = await createTestApp(db);
    ({ accountId } = await createMaster(db.app, { accountName: 'Salon Iris', email: 'owner@iris.pl', password: PASSWORD }));
    ({ accountId: otherId } = await createMaster(db.app, { accountName: 'Other', email: 'o@other.pl', password: PASSWORD }));
    owner = new Client(t.url);
    await owner.post('/auth/login', { email: 'owner@iris.pl', password: PASSWORD });
    await owner.post('/staff', { displayName: 'Iris', publicSlug: 'iris' });
    await db.admin.query("INSERT INTO clients (account_id, name, phone_encrypted, phone_hash) VALUES ($1, 'Tajna', '\\x01', '\\x02')", [accountId]);

    // Не суперпользователь: суперпользователь обходит RLS, и тест не проверил бы работу через контекст Account.
    await db.admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${ROLE}') THEN CREATE ROLE ${ROLE} LOGIN PASSWORD '${ROLE}' NOSUPERUSER NOBYPASSRLS; END IF;
    END $$`);
    await db.admin.query(`GRANT USAGE ON SCHEMA public TO ${ROLE}; GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${ROLE};
      GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}; GRANT EXECUTE ON FUNCTION admin_accounts() TO ${ROLE}`);
    const url = new URL(db.admin.options.connectionString!);
    url.username = ROLE;
    url.password = ROLE;
    adminPool = new Pool({ connectionString: url.toString(), max: 2 });
    admin = new PlatformAdmin(adminPool);
  });
  after(async () => {
    await adminPool.end();
    await t.close();
    await db.close();
  });

  test('список Account с цифрами для поддержки; приложению функция недоступна', async () => {
    const rows = await admin.accounts();
    const iris = rows.find((a) => a.id === accountId)!;
    assert.deepEqual([iris.name, iris.status, iris.plan, iris.owners, iris.staff_count, iris.sms_included], ['Salon Iris', 'active', 'alpha', 'owner@iris.pl', 1, 40]);
    assert.ok(rows.some((a) => a.id === otherId));
    await assert.rejects(db.app.pool.query('SELECT * FROM admin_accounts()'), /permission denied/);
  });

  test('карточка Account без клиентских данных', async () => {
    const card = await admin.account(accountId);
    assert.deepEqual(card.users.map((u: { email: string }) => u.email), ['owner@iris.pl']);
    assert.deepEqual(card.staff.map((s: { public_slug: string }) => s.public_slug), ['iris']);
    assert.ok(!JSON.stringify(card).includes('Tajna'));
    assert.ok(!('clients' in card));
  });

  test('приостановка закрывает вход, сессию и публичную страницу; восстановление возвращает', async () => {
    await admin.setStatus(accountId, 'suspended');
    assert.equal((await owner.get('/auth/me')).status, 401, 'действующая сессия перестаёт работать');
    assert.equal((await new Client(t.url).post('/auth/login', { email: 'owner@iris.pl', password: PASSWORD })).status, 401);
    assert.equal((await new Client(t.url).get('/public/staff/iris')).status, 404);
    assert.equal((await admin.accounts()).find((a) => a.id === otherId)!.status, 'active', 'другие Account не затронуты');

    await admin.setStatus(accountId, 'active');
    const again = new Client(t.url);
    assert.equal((await again.post('/auth/login', { email: 'owner@iris.pl', password: PASSWORD })).status, 200);
    assert.equal((await new Client(t.url).get('/public/staff/iris')).status, 200);
  });

  test('план, пакет SMS и докупка; все действия в журнале Account без пользователя', async () => {
    await admin.setPlan(accountId, 'solo', 100);
    await admin.addSms(accountId, 50, 'admin');
    const row = (await admin.accounts()).find((a) => a.id === accountId)!;
    assert.deepEqual([row.plan, row.sms_included], ['solo', 100]);
    const ledger = await db.admin.query('SELECT delta, reason FROM sms_ledger WHERE account_id = $1', [accountId]);
    assert.deepEqual(ledger.rows, [{ delta: 50, reason: 'purchase:admin' }]);
    const log = await db.admin.query("SELECT action, actor_id FROM audit_log WHERE account_id = $1 AND action LIKE 'admin.%' ORDER BY id", [accountId]);
    assert.deepEqual(log.rows.map((r) => [r.action, r.actor_id]), [
      ['admin.suspended', null],
      ['admin.active', null],
      ['admin.plan', null],
      ['admin.sms', null],
    ]);
  });

  test('ошибки ввода и неизвестный Account', async () => {
    await assert.rejects(admin.setStatus('not-a-uuid', 'active'), ValidationError);
    await assert.rejects(admin.setStatus('00000000-0000-4000-8000-000000000000', 'active'), NotFoundError);
    await assert.rejects(admin.setPlan(accountId, 'Bad Plan', 10), ValidationError);
    await assert.rejects(admin.addSms(accountId, 0, 'x'), ValidationError);
  });
});
