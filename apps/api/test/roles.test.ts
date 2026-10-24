import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { addDays, localDate, zonedToUtc } from '../src/availability/zoned-time';
import { BookingsService } from '../src/bookings/bookings.service';
import { Client, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const WAW = 'Europe/Warsaw';

describe('роли внутри Account (DATA_MODEL.md, раздел 4)', () => {
  let db: TestDb;
  let t: TestApp;
  let accountId: string;
  let owner: Client;
  let staffUser: Client;
  let assistant: Client;
  let s1: string;
  let s2: string;
  let staffUserId: string;
  let bookingS1: string;
  let bookingS2: string;

  const login = async (email: string, password = PASSWORD) => {
    const c = new Client(t.url);
    const r = await c.post('/auth/login', { email, password });
    assert.equal(r.status, 200, `login ${email}`);
    return c;
  };

  before(async () => {
    db = await createTestDb('roles');
    t = await createTestApp(db);
    ({ accountId } = await createMaster(db.app, { accountName: 'Salon', email: 'owner@salon.pl', password: PASSWORD }));
    owner = await login('owner@salon.pl');

    s1 = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'salon-ola' })).body.id;
    s2 = (await owner.post('/staff', { displayName: 'Ewa', publicSlug: 'salon-ewa' })).body.id;
    const created = await owner.post('/users', { email: 'ola@salon.pl', role: 'staff', password: PASSWORD, staffId: s1 });
    assert.equal(created.status, 201);
    staffUserId = created.body.id;
    assert.equal((await owner.post('/users', { email: 'desk@salon.pl', role: 'assistant', password: PASSWORD })).status, 201);
    staffUser = await login('ola@salon.pl');
    assistant = await login('desk@salon.pl');

    // Записи у обоих специалистов, созданные напрямую сервисом.
    const service = await owner.post('/services', { name: { pl: 'Strzyżenie' }, variants: [{ durationMin: 30, price: 80 }] });
    const serviceId = service.body.service.id;
    const variantId = service.body.service.variants[0].id;
    for (const id of [s1, s2]) await owner.put(`/staff/${id}/services/${serviceId}`);
    const clientId = randomUUID();
    await db.admin.query("INSERT INTO clients (id, account_id, name, phone_encrypted, phone_hash) VALUES ($1, $2, 'K', '\\x01', '\\x02')", [clientId, accountId]);
    const bookings = new BookingsService(db.app);
    const day = addDays(localDate(new Date(), WAW), 5);
    const startsAt = zonedToUtc(day, 10 * 60, WAW)!;
    const mk = (staffId: string) => bookings.create({ accountId, staffId, clientId, serviceId, variantId, startsAt, requiresApproval: true });
    bookingS1 = (await mk(s1)).id;
    bookingS2 = (await mk(s2)).id;
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  const range = () => {
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 30 * 86_400_000).toISOString();
    return `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  };

  test('пользователей, реквизиты оплаты и каталог меняет только owner', async () => {
    for (const c of [staffUser, assistant]) {
      assert.deepEqual((await c.get('/users')).body, { error: 'FORBIDDEN' });
      assert.equal((await c.post('/users', { email: 'x@salon.pl', role: 'owner', password: PASSWORD })).status, 403);
      assert.equal((await c.get('/account/payment')).status, 403);
      assert.equal((await c.post('/services', { name: { pl: 'X' }, variants: [{ durationMin: 30, price: 1 }] })).status, 403);
      assert.equal((await c.post('/staff', { displayName: 'X', publicSlug: 'salon-x' })).status, 403);
      assert.equal((await c.get('/services')).status, 200, 'читать каталог можно');
    }
    assert.equal((await owner.get('/users')).body.length, 3);
  });

  test('staff ведёт только своё расписание, assistant ведёт всех', async () => {
    const week = { intervals: [{ weekday: 1, start: '09:00', end: '17:00' }] };
    assert.equal((await staffUser.put(`/staff/${s1}/working-hours`, week)).status, 204);
    assert.equal((await staffUser.put(`/staff/${s2}/working-hours`, week)).status, 403);
    assert.equal((await staffUser.post(`/staff/${s2}/days-off`, { date: '2030-01-01' })).status, 403);
    assert.equal((await staffUser.get(`/staff/${s2}/working-hours`)).status, 403);
    assert.equal((await assistant.put(`/staff/${s2}/working-hours`, week)).status, 204);
    assert.equal((await assistant.post(`/staff/${s1}/days-off`, { date: '2030-01-01' })).status, 201);
  });

  test('настройки слотов меняют owner и сам специалист, но не assistant', async () => {
    assert.equal((await staffUser.patch(`/staff/${s1}/settings`, { slotStepMin: 30 })).body.slotStepMin, 30);
    assert.equal((await staffUser.patch(`/staff/${s2}/settings`, { slotStepMin: 30 })).status, 403);
    assert.equal((await assistant.patch(`/staff/${s1}/settings`, { slotStepMin: 15 })).status, 403);
    assert.equal((await owner.patch(`/staff/${s2}/settings`, { slotStepMin: 20 })).body.slotStepMin, 20);
  });

  test('staff видит и подтверждает только свои записи', async () => {
    const mine = (await staffUser.get(`/bookings?${range()}`)).body;
    assert.deepEqual(mine.map((b: { id: string }) => b.id), [bookingS1]);
    assert.deepEqual((await staffUser.get(`/bookings?${range()}&staffId=${s2}`)).body, []);
    assert.equal((await staffUser.post(`/bookings/${bookingS2}/transition`, { to: 'confirmed' })).status, 403);
    assert.equal((await staffUser.post(`/bookings/${bookingS1}/transition`, { to: 'confirmed' })).body.status, 'confirmed');
    assert.equal((await assistant.get(`/bookings?${range()}`)).body.length, 2);
    assert.equal((await assistant.post(`/bookings/${bookingS2}/transition`, { to: 'confirmed' })).body.status, 'confirmed');
  });

  test('смена роли действует сразу, без повторного входа', async () => {
    assert.equal((await owner.patch(`/users/${staffUserId}`, { role: 'assistant' })).body.role, 'assistant');
    assert.equal((await staffUser.get(`/bookings?${range()}`)).body.length, 2);
    await owner.patch(`/users/${staffUserId}`, { role: 'staff' });
    assert.equal((await staffUser.get(`/bookings?${range()}`)).body.length, 1);
  });

  test('специалист привязывается только к одному пользователю', async () => {
    const r = await owner.post('/users', { email: 'ola2@salon.pl', role: 'staff', password: PASSWORD, staffId: s1 });
    assert.deepEqual([r.status, r.body], [409, { error: 'STAFF_LINKED' }]);
    assert.equal((await owner.get('/users')).body.length, 3, 'неудачное создание откатилось целиком');
  });

  test('последнего owner нельзя разжаловать или удалить', async () => {
    const me = (await owner.get('/auth/me')).body.userId;
    assert.deepEqual((await owner.patch(`/users/${me}`, { role: 'staff' })).body, { error: 'LAST_OWNER' });
    assert.deepEqual((await owner.delete(`/users/${me}`)).body, { error: 'LAST_OWNER' });
  });

  test('смена своего пароля требует текущий пароль', async () => {
    assert.equal((await assistant.post('/auth/password', { currentPassword: 'wrong wrong', newPassword: 'brand new pass' })).status, 401);
    assert.equal((await assistant.post('/auth/password', { currentPassword: PASSWORD, newPassword: 'short' })).status, 400);
    assert.equal((await assistant.post('/auth/password', { currentPassword: PASSWORD, newPassword: 'brand new pass' })).status, 204);
    await login('desk@salon.pl', 'brand new pass');
  });

  test('удалённый пользователь теряет доступ сразу', async () => {
    assert.equal((await owner.delete(`/users/${staffUserId}`)).status, 204);
    assert.equal((await staffUser.get('/auth/me')).status, 401);
    const staff = await db.admin.query('SELECT user_id FROM staff WHERE id = $1', [s1]);
    assert.equal(staff.rows[0].user_id, null, 'специалист остаётся, связь обнуляется');
  });

  test('БД не даёт привязать специалиста к пользователю другого Account', async () => {
    const other = await createMaster(db.app, { accountName: 'Other', email: 'boss@other.pl', password: PASSWORD });
    await assert.rejects(db.admin.query('UPDATE staff SET user_id = $1 WHERE id = $2', [other.userId, s1]), /staff_user_fk/);
  });
});
