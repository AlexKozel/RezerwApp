import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { BookingsService } from '../src/bookings/bookings.service';
import { Client, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const DAY = 24 * 3_600_000;

describe('аналитика: «сколько вы сэкономили» и маржа (D-056)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let staffUser: Client;
  let assistant: Client;
  let accountId: string;
  let serviceA: { id: string; variants: Array<{ id: string }> };
  let firstA: string;
  const range = () => `from=${encodeURIComponent(new Date(Date.now() - DAY).toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 30 * DAY).toISOString())}`;
  const login = async (email: string) => {
    const c = new Client(t.url);
    await c.post('/auth/login', { email, password: PASSWORD });
    return c;
  };

  before(async () => {
    db = await createTestDb('analytics');
    t = await createTestApp(db);
    ({ accountId } = await createMaster(db.app, { accountName: 'Studio', email: 'owner@an.pl', password: PASSWORD }));
    owner = await login('owner@an.pl');
    await owner.patch('/account/payment', { blikPhone: '600700800' });
    const s1 = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'an-ola' })).body.id;
    const s2 = (await owner.post('/staff', { displayName: 'Ewa', publicSlug: 'an-ewa' })).body.id;
    await owner.post('/users', { email: 'ola@an.pl', role: 'staff', password: PASSWORD, staffId: s1 });
    await owner.post('/users', { email: 'desk@an.pl', role: 'assistant', password: PASSWORD });
    staffUser = await login('ola@an.pl');
    assistant = await login('desk@an.pl');

    serviceA = (await owner.post('/services', { name: { pl: 'Strzyżenie' }, costPrice: 30, variants: [{ durationMin: 60, price: 100 }] })).body.service;
    const serviceB = (await owner.post('/services', {
      name: { pl: 'Koloryzacja' },
      prepaymentMethod: 'manual_blik',
      depositMode: 'fixed',
      depositValue: 40,
      variants: [{ durationMin: 60, price: 200 }],
    })).body.service;
    for (const staff of [s1, s2]) for (const svc of [serviceA, serviceB]) await owner.put(`/staff/${staff}/services/${svc.id}`);

    const clientId = randomUUID();
    await db.admin.query("INSERT INTO clients (id, account_id, name, phone_encrypted, phone_hash) VALUES ($1, $2, 'K', '\\x01', '\\x02')", [clientId, accountId]);
    const bookings = new BookingsService(db.app);
    const at = (days: number) => new Date(Math.ceil((Date.now() + days * DAY) / 3_600_000) * 3_600_000);
    const book = async (svc: typeof serviceA, staffId: string, startsAt: Date, approval: boolean) =>
      (await bookings.create({ accountId, staffId, clientId, serviceId: svc.id, variantId: svc.variants[0]!.id, startsAt, requiresApproval: approval })).id;
    const go = (bookingId: string, to: 'confirmed' | 'completed' | 'no_show' | 'cancelled_by_client') =>
      bookings.transition({ accountId, bookingId, to, actor: 'master' });
    const withFee = async (bookingId: string) =>
      db.admin.query("INSERT INTO payment_requests (account_id, booking_id, mode, amount, code) VALUES ($1, $2, 'manual_blik', 40, $3)", [
        accountId,
        bookingId,
        bookingId.slice(0, 4).toUpperCase(),
      ]);

    // 3 визита A у Оли: завершены (выручка 3 × 100, себестоимость 3 × 30).
    for (const d of [2, 3, 4]) {
      const id = await book(serviceA, s1, at(d), false);
      firstA ??= id;
      await go(id, 'completed');
    }
    // Неявка без оплаты у Эвы.
    await go(await book(serviceA, s2, at(5), false), 'no_show');
    // B с оплатой у Оли: завершена (оплата засчитана) и неявка (оплата удержана).
    for (const [d, end] of [[6, 'completed'], [7, 'no_show']] as const) {
      const id = await book(serviceB, s1, at(d), true);
      await withFee(id);
      await go(id, 'confirmed');
      await go(id, end);
    }
    // Поздняя отмена клиентом у Эвы (визит через 3 часа, дедлайн 24 ч): оплата удержана.
    const late = await book(serviceB, s2, new Date(Date.now() + 3 * 3_600_000), true);
    await withFee(late);
    await go(late, 'confirmed');
    await go(late, 'cancelled_by_client');
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('сводка owner: статусы, неявки с оплатой и без, удержанные оплаты, выручка, маржа, комиссия', async () => {
    const r = (await owner.get(`/analytics/summary?${range()}&commissionPercent=15`)).body;
    assert.equal(r.bookings.completed, 4);
    assert.equal(r.bookings.no_show, 2);
    assert.equal(r.bookings.cancelled_by_client, 1);
    assert.deepEqual(r.noShowRate, { all: 0.33, withFee: 0.5, withoutFee: 0.25 });
    assert.deepEqual(r.bookingFee, { completedWithFee: 1, keptOnNoShow: 40, keptOnLateCancel: 40 });
    assert.equal(r.revenue, 500);
    assert.equal(r.revenueFromPriceSnapshot, true);
    assert.deepEqual(r.marketplaceCommission, { percent: 15, amount: 75, formula: 'revenue × 15% = 75' });
    assert.deepEqual(r.services.map((s: { name: { pl: string }; completed: number; revenue: number; cost: number | null; margin: number | null }) => [s.name.pl, s.completed, s.revenue, s.cost, s.margin]), [
      ['Strzyżenie', 3, 300, 90, 210],
      ['Koloryzacja', 1, 200, null, null],
    ]);
  });

  test('смена цены не меняет выручку за прошлые визиты (снимок цены)', async () => {
    await owner.patch(`/variants/${serviceA.variants[0]!.id}`, { price: 150 });
    assert.equal((await owner.get(`/analytics/summary?${range()}`)).body.revenue, 500);
  });

  test('запись без снимка цены считается по текущей цене и помечается', async () => {
    await db.admin.query('UPDATE bookings SET price = NULL WHERE id = $1', [firstA]);
    const r = (await owner.get(`/analytics/summary?${range()}`)).body;
    assert.equal(r.revenue, 550);
    assert.equal(r.revenueFromPriceSnapshot, false);
    await db.admin.query('UPDATE bookings SET price = 100 WHERE id = $1', [firstA]);
  });

  test('staff видит только свои записи, assistant не видит аналитику', async () => {
    const r = (await staffUser.get(`/analytics/summary?${range()}`)).body;
    assert.deepEqual([r.bookings.completed, r.bookings.no_show, r.bookings.cancelled_by_client, r.revenue], [4, 1, 0, 500]);
    assert.equal((await assistant.get(`/analytics/summary?${range()}`)).status, 403);
    assert.equal((await owner.get('/analytics/summary?from=2030-01-02T00:00:00Z&to=2030-01-01T00:00:00Z')).status, 400);
  });
});
