import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { BookingsService } from '../src/bookings/bookings.service';
import { Client, TEST_OTP, createTestApp, inviteUser, type TestApp } from './helpers/app';
import { addClient, createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('ненадёжный клиент (D-066)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let staff: Client;
  let desk: Client;
  let anon: Client;
  let accountId: string;
  let staffId: string;
  let free: { id: string; variants: Array<{ id: string }> };
  let paid: { id: string; variants: Array<{ id: string }> };
  let bookings: BookingsService;
  let hour = 0;

  const login = async (email: string) => {
    const c = new Client(t.url);
    assert.equal((await c.post('/auth/login', { email, password: PASSWORD })).status, 200, email);
    return c;
  };
  /** Запись клиента со сдвигом от «сейчас» в днях; каждая на свой час, чтобы не пересекаться. */
  const visit = async (clientId: string, daysFromNow: number, status: string) => {
    hour += 1;
    const b = await bookings.create({
      accountId,
      staffId,
      clientId,
      serviceId: free.id,
      variantId: free.variants[0]!.id,
      startsAt: new Date(Date.now() + daysFromNow * DAY + hour * HOUR),
      requiresApproval: false,
      actor: 'master',
    });
    if (status !== 'confirmed') {
      await db.admin.query('UPDATE bookings SET status = $2, late_cancel = $3, hold_expires_at = NULL WHERE id = $1', [
        b.id,
        status === 'late_cancel' ? 'cancelled_by_client' : status,
        status === 'late_cancel',
      ]);
    }
    return b.id;
  };
  /** Клиент через API: с настоящим зашифрованным телефоном (карточка его расшифровывает). */
  let phoneSeq = 0;
  const newClient = async (name: string) => {
    phoneSeq += 1;
    const r = await owner.post('/clients', { name, phone: `+4852000${String(phoneSeq).padStart(4, '0')}` });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };
  const left = async (clientId: string) =>
    (await db.app.withAccount(accountId, (c) => c.query<{ n: number | null }>('SELECT client_unreliable_visits_left($1) AS n', [clientId]))).rows[0]!.n;

  before(async () => {
    db = await createTestDb('unreliable');
    t = await createTestApp(db);
    anon = new Client(t.url);
    bookings = new BookingsService(db.app);
    await db.admin.query("INSERT INTO consent_documents (type, language, version, body) VALUES ('terms', 'pl', '1', 'R'), ('privacy', 'pl', '1', 'P')");
    ({ accountId } = await createMaster(db.app, { accountName: 'Studio', email: 'owner@u.pl', password: PASSWORD }));
    owner = await login('owner@u.pl');
    staffId = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'u-ola' })).body.id;
    await inviteUser(t.url, owner, { email: 'ola@u.pl', role: 'staff', staffId }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'desk@u.pl', role: 'assistant' }, PASSWORD);
    staff = await login('ola@u.pl');
    desk = await login('desk@u.pl');
    const policy = (await owner.post('/policies', { freeCancelHours: 24, maxReschedules: 1, depositOnLateCancel: 'keep' })).body.id;
    free = (await owner.post('/services', { name: { pl: 'Manicure' }, requiresManualConfirm: false, cancelPolicyId: policy, variants: [{ durationMin: 60, price: 150 }] })).body.service;
    await owner.patch('/account/payment', { blikPhone: '600700800', recipient: 'Studio' });
    paid = (await owner.post('/services', {
      name: { pl: 'Rzęsy' },
      requiresManualConfirm: false,
      cancelPolicyId: policy,
      prepaymentMethod: 'manual_blik',
      depositMode: 'fixed',
      depositValue: 40,
      depositScope: 'all',
      variants: [{ durationMin: 60, price: 200 }],
    })).body.service;
    for (const s of [free, paid]) await owner.put(`/staff/${staffId}/services/${s.id}`);
    await owner.put(`/staff/${staffId}/working-hours`, { intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })) });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('поздняя отмена фиксируется в момент отмены: позже дедлайна да, раньше нет', async () => {
    const clientId = await addClient(db.admin, accountId, 'cancel-test');
    const soon = await visit(clientId, 0.1, 'confirmed');
    const later = await visit(clientId, 10, 'confirmed');
    for (const id of [soon, later]) await owner.post(`/bookings/${id}/transition`, { to: 'cancelled_by_client' });
    const rows = await db.admin.query('SELECT id, late_cancel FROM bookings WHERE id = ANY($1)', [[soon, later]]);
    const late = Object.fromEntries(rows.rows.map((r) => [r.id, r.late_cancel]));
    assert.deepEqual([late[soon], late[later]], [true, false]);
    // Ограничения БД: флаги только у тех статусов, к которым они относятся.
    const active = await visit(clientId, 5, 'confirmed');
    await assert.rejects(db.admin.query('UPDATE bookings SET late_cancel = true WHERE id = $1', [active]), /bookings_late_cancel_status/);
    await assert.rejects(db.admin.query('UPDATE bookings SET excused_at = now() WHERE id = $1', [active]), /bookings_excuse_incident/);
    await assert.rejects(db.admin.query('UPDATE bookings SET excused_at = now() WHERE id = $1', [later]), /bookings_excuse_incident/, 'ранняя отмена не случай');
  });

  test('правило: порог, отмены до дедлайна и отмены мастером не считаются, серия визитов обнуляет', async () => {
    const c = await addClient(db.admin, accountId, 'rules');
    await visit(c, -40, 'no_show');
    assert.equal(await left(c), null, 'один случай: ещё надёжная');
    await visit(c, -35, 'cancelled_by_client'); // до дедлайна
    await visit(c, -34, 'cancelled_by_master');
    await visit(c, -33, 'rescheduled');
    assert.equal(await left(c), null, 'не случаи');
    await visit(c, -30, 'late_cancel');
    assert.equal(await left(c), 2, 'два случая: ненадёжная, до снятия 2 визита');
    await visit(c, -20, 'completed');
    assert.equal(await left(c), 1);
    await visit(c, -10, 'completed');
    assert.equal(await left(c), null, 'исправилась');
    await visit(c, -5, 'no_show');
    assert.equal(await left(c), null, 'после исправления счёт с нуля: один новый случай не возвращает отметку');
  });

  test('случаи старше 12 месяцев сгорают', async () => {
    const c = await addClient(db.admin, accountId, 'old');
    await visit(c, -400, 'no_show');
    await visit(c, -380, 'no_show');
    assert.equal(await left(c), null);
    await visit(c, -100, 'no_show');
    assert.equal(await left(c), null, 'в окне только один случай');
  });

  test('уважительная причина: мастер прощает случай; только у неявки или поздней отмены; ассистент не может', async () => {
    const c = await newClient('excuse');
    const first = await visit(c, -50, 'no_show');
    await visit(c, -40, 'late_cancel');
    const done = await visit(c, -30, 'completed');
    assert.equal(await left(c), 1);
    assert.equal((await desk.post(`/bookings/${first}/excuse`, { excused: true })).status, 403);
    assert.equal((await staff.post(`/bookings/${first}/excuse`, { excused: true })).status, 204);
    assert.equal(await left(c), null);
    const card = (await owner.get(`/clients/${c}`)).body;
    assert.deepEqual(
      card.bookings.filter((b: { id: string }) => b.id === first).map((b: { excused: boolean }) => b.excused),
      [true],
    );
    assert.equal((await owner.post(`/bookings/${first}/excuse`, { excused: false })).status, 204);
    assert.equal(await left(c), 1, 'отмена уважительной причины возвращает случай');
    const wrong = await owner.post(`/bookings/${done}/excuse`, { excused: true });
    assert.deepEqual([wrong.status, wrong.body], [409, { error: 'NOT_AN_INCIDENT' }]);
  });

  test('ручная отметка: сразу ненадёжная, снимается мастером или визитами; видно в списке, карточке и календаре', async () => {
    const c = await newClient('manual');
    assert.equal((await staff.post(`/clients/${c}/unreliable`, { marked: true })).status, 404, 'клиент не её: для неё не существует');
    const tomorrow = await visit(c, 1, 'confirmed');
    assert.equal((await desk.post(`/clients/${c}/unreliable`, { marked: true })).status, 403);
    assert.equal((await staff.post(`/clients/${c}/unreliable`, { marked: true })).status, 204);
    const card = (await owner.get(`/clients/${c}`)).body;
    assert.deepEqual(card.reliability, { unreliable: true, visitsLeft: 2, marked: true });
    assert.equal((await owner.get('/clients?search=manual')).body[0].unreliable, true);
    const from = new Date(Date.now()).toISOString();
    const to = new Date(Date.now() + 3 * DAY).toISOString();
    const cal = (await owner.get(`/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).body;
    assert.equal(cal.find((b: { id: string }) => b.id === tomorrow).clientUnreliable, true);
    assert.equal((await staff.post(`/clients/${c}/unreliable`, { marked: false })).status, 204);
    assert.deepEqual((await owner.get(`/clients/${c}`)).body.reliability, { unreliable: false, visitsLeft: null, marked: false });
    const log = (await owner.get('/audit')).body as Array<{ action: string }>;
    assert.ok(log.some((e) => e.action === 'client.unreliable'));
  });

  test('настройки: только owner; предоплату нельзя включить без BLIK и стереть BLIK, пока она включена', async () => {
    assert.deepEqual((await owner.get('/account/reliability')).body, { threshold: 2, redeemVisits: 2, depositPercent: null });
    assert.equal((await staff.patch('/account/reliability', { threshold: 1 })).status, 403);
    assert.equal((await owner.patch('/account/reliability', { depositPercent: 60 })).status, 400, 'не выше 50% (D-014)');
    await createMaster(db.app, { accountName: 'Bez BLIK', email: 'noblik@u.pl', password: PASSWORD });
    const noBlik = await login('noblik@u.pl');
    assert.equal((await noBlik.patch('/account/reliability', { depositPercent: 20 })).status, 400);
    assert.deepEqual((await owner.patch('/account/reliability', { depositPercent: 20 })).body, { threshold: 2, redeemVisits: 2, depositPercent: 20 });
    assert.equal((await owner.patch('/account/payment', { blikPhone: null })).status, 400);
    await owner.patch('/account/reliability', { depositPercent: null });
  });

  test('публичная запись: ненадёжной нужна предоплата; сумма и путь назад до записи, запись только после согласия', async () => {
    const phone = '+48 511 222 333';
    const book = (service: typeof free, daysAhead: number, extra: Record<string, unknown> = {}) =>
      anon.post('/public/staff/u-ola/bookings', {
        serviceId: service.id,
        variantId: service.variants[0]!.id,
        startsAt: new Date(Math.ceil((Date.now() + daysAhead * DAY) / (15 * 60_000)) * 15 * 60_000).toISOString(),
        name: 'Klientka',
        phone,
        otpCode: TEST_OTP,
        acceptTerms: true,
        acceptPrivacy: true,
        ...extra,
      });
    // Клиентка появляется через запись, затем две неявки в прошлом.
    assert.equal((await book(free, 20)).status, 201);
    const clientId = (await owner.get('/clients?search=511222333')).body[0].id as string;
    await visit(clientId, -20, 'no_show');
    await visit(clientId, -10, 'no_show');

    assert.equal((await book(free, 21)).body.status, 'confirmed', 'опция выключена: записывается как обычно');
    await owner.patch('/account/reliability', { depositPercent: 20 });
    await t.resetRateLimits();
    const before = (await db.admin.query('SELECT count(*)::int AS n FROM bookings WHERE client_id = $1', [clientId])).rows[0].n;
    const asked = await book(free, 22);
    assert.deepEqual([asked.status, asked.body], [409, { error: 'DEPOSIT_REQUIRED', amount: 30, visitsLeft: 2 }]);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM bookings WHERE client_id = $1', [clientId])).rows[0].n, before, 'без согласия запись не создана');

    const accepted = await book(free, 22, { acceptDeposit: true });
    assert.equal(accepted.status, 201);
    assert.equal(accepted.body.status, 'pending');
    assert.equal(accepted.body.bookingFee.amount, 30);
    assert.equal(accepted.body.unreliableVisitsLeft, 2);

    // Услуга сама требует оплату: берётся она, отдельного согласия не нужно.
    const own = await book(paid, 23);
    assert.equal(own.status, 201);
    assert.deepEqual([own.body.bookingFee.amount, own.body.unreliableVisitsLeft], [40, null]);
    await owner.patch('/account/reliability', { depositPercent: null });
  });

  test('порог из настроек: при пороге 1 хватает одной неявки', async () => {
    const c = await addClient(db.admin, accountId, 'threshold');
    await visit(c, -15, 'no_show');
    assert.equal(await left(c), null);
    await owner.patch('/account/reliability', { threshold: 1, redeemVisits: 3 });
    assert.equal(await left(c), 3);
    await owner.patch('/account/reliability', { threshold: 2, redeemVisits: 2 });
  });
});
