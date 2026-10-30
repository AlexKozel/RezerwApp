import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { applyDiscount, bestDiscount } from '../src/bookings/discounts';
import { Client, TEST_OTP, createTestApp, inviteUser, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';
import { slotWithinDay } from './helpers/time';

const PASSWORD = 'very secret 123';
const DAY = 86_400_000;

describe('скидки: выбор и расчёт (D-070)', () => {
  test('не складываются, берётся наибольшая; сумма до копеек', () => {
    assert.equal(bestDiscount([null, { percent: 10, reason: 'personal' }, { percent: 15, reason: 'personal' }])?.percent, 15);
    assert.equal(bestDiscount([null]), null);
    assert.deepEqual(applyDiscount(200, { percent: 10, reason: 'personal' }), { price: 180, amount: 20 });
    assert.deepEqual(applyDiscount(99.99, { percent: 15, reason: 'personal' }), { price: 84.99, amount: 15 });
    assert.deepEqual(applyDiscount(120, null), { price: 120, amount: null });
  });
});

describe('HTTP: персональная скидка клиенту (D-070)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let ola: Client;
  let desk: Client;
  let anon: Client;
  let staffId: string;
  let paid: { id: string; variants: Array<{ id: string }> };
  let phoneSeq = 0;

  const login = async (email: string) => {
    const c = new Client(t.url);
    assert.equal((await c.post('/auth/login', { email, password: PASSWORD })).status, 200, email);
    return c;
  };
  const book = async (phone: string, startsAt: Date) => {
    await t.resetRateLimits();
    const r = await anon.post('/public/staff/d-ola/bookings', {
      serviceId: paid.id,
      variantId: paid.variants[0]!.id,
      startsAt: startsAt.toISOString(),
      name: 'Klientka',
      phone,
      otpCode: TEST_OTP,
      acceptTerms: true,
      acceptPrivacy: true,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body;
  };
  const newClient = async (by: Client) => {
    phoneSeq += 1;
    const r = await by.post('/clients', { name: `K${phoneSeq}`, phone: `+4854000${String(phoneSeq).padStart(4, '0')}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };

  before(async () => {
    db = await createTestDb('discounts');
    t = await createTestApp(db);
    anon = new Client(t.url);
    await db.admin.query("INSERT INTO consent_documents (type, language, version, body) VALUES ('terms', 'pl', '1', 'R'), ('privacy', 'pl', '1', 'P')");
    await createMaster(db.app, { accountName: 'Studio', email: 'owner@d.pl', password: PASSWORD });
    owner = await login('owner@d.pl');
    staffId = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'd-ola' })).body.id;
    await inviteUser(t.url, owner, { email: 'ola@d.pl', role: 'staff', staffId }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'desk@d.pl', role: 'assistant' }, PASSWORD);
    ola = await login('ola@d.pl');
    desk = await login('desk@d.pl');
    await owner.patch('/account/payment', { blikPhone: '600700800' });
    // Оплата 20% от цены для новых клиентов: проверяем, что процент считается от цены со скидкой.
    paid = (await owner.post('/services', {
      name: { pl: 'Koloryzacja' },
      requiresManualConfirm: false,
      prepaymentMethod: 'manual_blik',
      depositMode: 'percent',
      depositValue: 20,
      variants: [{ durationMin: 60, price: 200 }],
    })).body.service;
    await owner.put(`/staff/${staffId}/services/${paid.id}`);
    await owner.put(`/staff/${staffId}/working-hours`, { intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })) });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('ставит owner; staff только с разрешения owner и только своим клиентам; assistant нет; в аудите', async () => {
    const mine = await newClient(ola);
    const other = await newClient(owner);
    assert.equal((await owner.patch(`/clients/${other}`, { discountPercent: 60 })).status, 400, 'не выше 50%');
    assert.equal((await owner.patch(`/clients/${other}`, { discountPercent: 10 })).status, 204);
    assert.equal((await owner.get(`/clients/${other}`)).body.discountPercent, 10);
    assert.equal((await owner.get('/clients')).body.find((c: { id: string }) => c.id === other).discountPercent, 10);

    assert.equal((await ola.get(`/clients/${mine}`)).body.canSetDiscount, false);
    assert.equal((await ola.patch(`/clients/${mine}`, { discountPercent: 5 })).status, 403, 'без разрешения owner');
    assert.equal((await ola.patch('/account/discounts', { staffCanDiscount: true })).status, 403);
    assert.deepEqual((await owner.patch('/account/discounts', { staffCanDiscount: true })).body, { staffCanDiscount: true });
    assert.equal((await ola.get(`/clients/${mine}`)).body.canSetDiscount, true);
    assert.equal((await ola.patch(`/clients/${mine}`, { discountPercent: 5 })).status, 204);
    assert.equal((await ola.patch(`/clients/${other}`, { discountPercent: 5 })).status, 404, 'чужой клиент для неё не существует');
    assert.equal((await desk.patch(`/clients/${other}`, { discountPercent: 5 })).status, 403);
    assert.equal((await owner.patch(`/clients/${mine}`, { discountPercent: null })).status, 204);
    assert.equal((await owner.get(`/clients/${mine}`)).body.discountPercent, null);
    await owner.patch('/account/discounts', { staffCanDiscount: false });
    const log = (await owner.get('/audit')).body as Array<{ action: string; actorEmail: string }>;
    assert.ok(log.some((e) => e.action === 'client.discount' && e.actorEmail === 'ola@d.pl'));
  });

  test('онлайн-запись: цена со скидкой в записи, процентная оплата от неё, клиент видит цену и скидку', async () => {
    const phone = '+48541111111';
    const first = await book(phone, slotWithinDay(5 * DAY));
    assert.deepEqual([first.price, first.discountPercent, first.bookingFee.amount], [200, null, 40]);
    const id = (await owner.get('/clients?search=541111111')).body[0].id;
    await owner.patch(`/clients/${id}`, { discountPercent: 10 });

    const second = await book(phone, slotWithinDay(6 * DAY));
    assert.deepEqual([second.price, second.discountPercent, second.bookingFee.amount], [180, 10, 36]);
    const row = (await db.admin.query('SELECT price, discount_percent, discount_amount, discount_reason FROM bookings WHERE id = $1', [second.bookingId])).rows[0];
    assert.deepEqual([Number(row.price), row.discount_percent, Number(row.discount_amount), row.discount_reason], [180, 10, 20, 'personal']);
    const view = (await anon.get(`/public/bookings/${second.manageToken}`)).body;
    assert.deepEqual([view.price, view.discountPercent], [180, 10]);
  });

  test('ручная запись мастером тоже со скидкой; перенос сохраняет скидку исходной записи', async () => {
    const id = (await owner.get('/clients?search=541111111')).body[0].id;
    const manual = await owner.post('/bookings', { staffId, serviceId: paid.id, variantId: paid.variants[0]!.id, startsAt: slotWithinDay(8 * DAY).toISOString(), clientId: id });
    assert.equal(manual.status, 201, JSON.stringify(manual.body));
    const cal = (await owner.get(`/bookings?from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 10 * DAY).toISOString())}`)).body;
    const m = cal.find((b: { id: string }) => b.id === manual.body.id);
    assert.deepEqual([m.price, m.discountPercent, m.discountAmount], [180, 10, 20]);

    // Подтверждённая запись с оплатой, затем скидку клиенту меняют: перенос живёт по снимку исходной записи.
    // Прежние заявки подтверждены: у клиента не больше двух неподтверждённых (D-044).
    await db.admin.query("UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL WHERE client_id = $1 AND status = 'pending'", [id]);
    const b = await book('+48541111111', slotWithinDay(12 * DAY));
    await owner.post(`/bookings/${b.bookingId}/transition`, { to: 'confirmed' });
    await owner.patch(`/clients/${id}`, { discountPercent: 30 });
    const moved = await anon.post(`/public/bookings/${b.manageToken}/reschedule`, { startsAt: slotWithinDay(13 * DAY).toISOString() });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const view = (await anon.get(`/public/bookings/${moved.body.token}`)).body;
    assert.deepEqual([view.price, view.discountPercent], [180, 10]);
    await owner.patch(`/clients/${id}`, { discountPercent: 10 });
  });

  test('«Результаты»: сколько скидок дано на завершённых визитах', async () => {
    const id = (await owner.get('/clients?search=541111111')).body[0].id;
    const past = await owner.post('/bookings', {
      staffId,
      serviceId: paid.id,
      variantId: paid.variants[0]!.id,
      startsAt: new Date(Math.floor((Date.now() - 2 * DAY) / 3_600_000) * 3_600_000).toISOString(),
      clientId: id,
    });
    assert.equal(past.status, 201, JSON.stringify(past.body));
    await owner.post(`/bookings/${past.body.id}/transition`, { to: 'completed' });
    const from = new Date(Date.now() - 5 * DAY).toISOString();
    const to = new Date(Date.now() + 30 * DAY).toISOString();
    const summary = (await owner.get(`/analytics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).body;
    assert.equal(summary.discounts, 20);
  });
});
