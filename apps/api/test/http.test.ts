import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { addDays, localDate, zonedToUtc } from '../src/availability/zoned-time';
import { PhoneHasher } from '../src/crypto/phone-hash';
import { Client, TEST_CONFIG, TEST_OTP, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const WAW = 'Europe/Warsaw';
const PASSWORD = 'very secret 123';

describe('HTTP: мастер настраивает запись, клиент записывается по ссылке', () => {
  let db: TestDb;
  let t: TestApp;
  let master: Client;
  let anon: Client;
  let staffId: string;
  let serviceA: { id: string; variants: Array<{ id: string }> };
  let serviceB: { id: string; variants: Array<{ id: string }> };
  // Дата через 10 дней в поясе Account: дальше minLead и ближе горизонта.
  const day = addDays(localDate(new Date(), WAW), 10);
  const at = (date: string, hh: number, mm = 0) => zonedToUtc(date, hh * 60 + mm, WAW)!.toISOString();

  const book = (overrides: Record<string, unknown> = {}) =>
    anon.post('/public/staff/anna-test/bookings', {
      serviceId: serviceA.id,
      variantId: serviceA.variants[0]!.id,
      startsAt: at(day, 9),
      name: 'Klientka',
      phone: '500 100 200',
      language: 'pl',
      otpCode: TEST_OTP,
      acceptTerms: true,
      acceptPrivacy: true,
      ...overrides,
    });

  before(async () => {
    db = await createTestDb('http');
    t = await createTestApp(db);
    master = new Client(t.url);
    anon = new Client(t.url);
    await db.admin.query(
      "INSERT INTO consent_documents (type, language, version, body) VALUES ('terms', 'pl', '2026-1', 'Regulamin'), ('privacy', 'pl', '2026-1', 'Polityka')",
    );
    await createMaster(db.app, { accountName: 'Anna Nails', email: 'anna@example.pl', password: PASSWORD });
    await createMaster(db.app, { accountName: 'Other', email: 'other@example.pl', password: PASSWORD });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('/health проверяет БД и Redis', async () => {
    const r = await anon.get('/health');
    assert.deepEqual([r.status, r.body], [200, { status: 'ok' }]);
  });

  describe('вход мастера (D-041)', () => {
    test('без сессии кабинет недоступен', async () => {
      const r = await anon.get('/services');
      assert.deepEqual([r.status, r.body], [401, { error: 'UNAUTHORIZED' }]);
    });

    test('неверный пароль и несуществующий email дают одинаковый ответ', async () => {
      const wrong = await anon.post('/auth/login', { email: 'anna@example.pl', password: 'nope nope nope' });
      const missing = await anon.post('/auth/login', { email: 'ghost@example.pl', password: 'nope nope nope' });
      assert.deepEqual([wrong.status, wrong.body], [401, { error: 'INVALID_CREDENTIALS' }]);
      assert.deepEqual([missing.status, missing.body], [401, { error: 'INVALID_CREDENTIALS' }]);
      assert.equal(anon.hasCookie, false);
    });

    test('вход ставит httpOnly cookie, /auth/me возвращает Account из сессии', async () => {
      const r = await master.post('/auth/login', { email: 'ANNA@example.pl', password: PASSWORD });
      assert.equal(r.status, 200);
      assert.equal(r.body.role, 'owner');
      assert.match(r.headers.get('set-cookie') ?? '', /^rz_sid=[\w-]{43}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+$/);
      const me = await master.get('/auth/me');
      assert.equal(me.body.accountId, r.body.accountId);
      // В Redis лежит хеш токена, а не сам токен.
      const token = (r.headers.get('set-cookie') ?? '').split(';')[0]!.split('=')[1]!;
      assert.equal(await t.redis.exists(`session:${token}`), 0);
    });

    test('после 10 неудачных попыток вход для email блокируется (429)', async () => {
      const c = new Client(t.url);
      for (let i = 0; i < 10; i += 1) assert.equal((await c.post('/auth/login', { email: 'other@example.pl', password: 'wrong password' })).status, 401);
      const blocked = await c.post('/auth/login', { email: 'other@example.pl', password: PASSWORD });
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    });
  });

  describe('каталог и график', () => {
    test('специалист с публичной ссылкой; занятая ссылка отклоняется', async () => {
      const r = await master.post('/staff', { displayName: 'Anna', publicSlug: 'anna-test' });
      assert.equal(r.status, 201);
      staffId = r.body.id;
      const dup = await master.post('/staff', { displayName: 'Anna 2', publicSlug: 'anna-test' });
      assert.deepEqual([dup.status, dup.body], [409, { error: 'SLUG_TAKEN' }]);
      assert.equal((await master.post('/staff', { displayName: 'X', publicSlug: 'Bad Slug!' })).status, 400);
    });

    test('политика отмен версионируется', async () => {
      assert.equal((await master.post('/policies', { freeCancelHours: 24 })).body.version, 1);
      assert.equal((await master.post('/policies', { freeCancelHours: 48 })).body.version, 2);
    });

    test('оплата выше 50% запрещена, выше 30% разрешена с предупреждением (D-014)', async () => {
      const variants = [{ name: { pl: 'Standard' }, durationMin: 60, price: 100 }];
      const over = await master.post('/services', { name: { pl: 'X' }, prepaymentMethod: 'manual_blik', depositMode: 'percent', depositValue: 60, variants });
      assert.equal(over.status, 400);
      assert.equal(over.body.details.depositValue, 'above 50% of the price');
      const noMethod = await master.post('/services', { name: { pl: 'X' }, depositMode: 'fixed', depositValue: 10, variants });
      assert.equal(noMethod.status, 400);
      const warn = await master.post('/services', { name: { pl: 'X' }, prepaymentMethod: 'manual_blik', depositMode: 'fixed', depositValue: 40, variants });
      assert.equal(warn.status, 201);
      assert.equal(warn.body.depositWarning, true);
    });

    test('услуги назначаются специалисту, график задаётся по дням недели', async () => {
      const a = await master.post('/services', {
        name: { pl: 'Manicure', ru: 'Маникюр' },
        requiresManualConfirm: false,
        variants: [{ name: { pl: 'Klasyczny' }, durationMin: 60, bufferMin: 15, price: 100 }],
      });
      const b = await master.post('/services', {
        name: { pl: 'Hybryda' },
        prepaymentMethod: 'manual_blik',
        depositMode: 'percent',
        depositValue: 20,
        variants: [{ name: { pl: 'Standard' }, durationMin: 60, price: 150 }],
      });
      assert.equal(b.body.depositWarning, false);
      serviceA = a.body.service;
      serviceB = b.body.service;
      for (const id of [serviceA.id, serviceB.id]) assert.equal((await master.put(`/staff/${staffId}/services/${id}`)).status, 204);

      const overlap = await master.put(`/staff/${staffId}/working-hours`, {
        intervals: [{ weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '11:00', end: '13:00' }],
      });
      assert.equal(overlap.status, 400);
      const week = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '09:00', end: '17:00' }));
      assert.equal((await master.put(`/staff/${staffId}/working-hours`, { intervals: week })).status, 204);
      assert.equal((await master.get(`/staff/${staffId}/working-hours`)).body.length, 7);
    });

    test('другой мастер не видит чужой каталог и не меняет чужой график', async () => {
      const other = new Client(t.url);
      await other.post('/auth/login', { email: 'other@example.pl', password: PASSWORD }).catch(() => undefined);
      // Вход other заблокирован лимитом из теста выше: снимаем блокировку, как это сделало бы окно в 15 минут.
      await t.redis.del('rl:login:email:other@example.pl');
      assert.equal((await other.post('/auth/login', { email: 'other@example.pl', password: PASSWORD })).status, 200);
      assert.deepEqual((await other.get('/services')).body, []);
      const r = await other.put(`/staff/${staffId}/working-hours`, { intervals: [] });
      assert.equal(r.status, 404);
    });
  });

  describe('публичная запись', () => {
    test('страница специалиста показывает активные услуги и условия оплаты', async () => {
      const r = await anon.get('/public/staff/anna-test');
      assert.equal(r.status, 200);
      assert.equal(r.body.displayName, 'Anna');
      assert.equal(r.body.services.length, 2);
      const hybrid = r.body.services.find((s: { id: string }) => s.id === serviceB.id);
      assert.deepEqual(hybrid.bookingFee, { mode: 'percent', value: 20, appliesTo: 'new_clients', method: 'manual_blik' });
      assert.equal((await anon.get('/public/staff/nobody-here')).status, 404);
    });

    test('слоты: шаг 15 минут, визит внутри рабочего дня', async () => {
      const r = await anon.get(`/public/staff/anna-test/slots?variantId=${serviceA.variants[0]!.id}&from=${day}&to=${day}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.slots.length, (8 * 60 - 60) / 15 + 1);
      assert.equal(r.body.slots[0], at(day, 9));
      assert.equal(r.body.slots.at(-1), at(day, 16));
    });

    test('разовый выходной убирает все слоты дня (D-043)', async () => {
      const next = addDays(day, 1);
      assert.equal((await master.post(`/staff/${staffId}/days-off`, { date: next })).status, 201);
      const r = await anon.get(`/public/staff/anna-test/slots?variantId=${serviceA.variants[0]!.id}&from=${next}&to=${next}`);
      assert.deepEqual(r.body.slots, []);
    });

    test('запись требует согласий, кода OTP и времени из предложенных слотов', async () => {
      assert.deepEqual((await anon.post('/public/otp', { phone: '500 100 200' })).body, { alpha: true });
      assert.deepEqual((await book({ otpCode: '0000' })).body, { error: 'OTP_INVALID' });
      assert.deepEqual((await book({ acceptTerms: false })).body, { error: 'CONSENT_REQUIRED' });
      const offGrid = await book({ startsAt: at(day, 9, 7) });
      assert.deepEqual([offGrid.status, offGrid.body], [409, { error: 'SLOT_NOT_AVAILABLE' }]);
      const bad = await book({ phone: 'abc', startsAt: 'tomorrow' });
      assert.equal(bad.status, 400);
      assert.ok(bad.body.details.startsAt);
    });

    test('услуга без оплаты и без ручного подтверждения: сразу confirmed, слот с буфером занят', async () => {
      const r = await book();
      assert.equal(r.status, 201);
      assert.equal(r.body.status, 'confirmed');
      assert.equal(r.body.bookingFee, null);

      const slots = (await anon.get(`/public/staff/anna-test/slots?variantId=${serviceA.variants[0]!.id}&from=${day}&to=${day}`)).body.slots;
      assert.ok(!slots.includes(at(day, 9)));
      assert.ok(!slots.includes(at(day, 10)), 'буфер 15 минут после визита 09:00-10:00');
      assert.ok(slots.includes(at(day, 10, 15)));
      assert.deepEqual((await book({ phone: '600 200 300' })).body, { error: 'SLOT_NOT_AVAILABLE' });
    });

    test('телефон хранится зашифрованным, поиск по HMAC; согласия записаны с версией текста', async () => {
      const rows = await db.admin.query('SELECT id, phone_encrypted, phone_hash FROM clients');
      assert.equal(rows.rows.length, 1);
      const [client] = rows.rows;
      assert.ok(!client.phone_encrypted.toString('latin1').includes('500100200'));
      assert.deepEqual(client.phone_hash, new PhoneHasher(TEST_CONFIG.phoneHashPepper).hash('+48500100200'));
      const consents = await db.admin.query('SELECT type, text_version FROM consents WHERE client_id = $1 ORDER BY type', [client.id]);
      assert.deepEqual(consents.rows, [{ type: 'privacy', text_version: '2026-1' }, { type: 'terms', text_version: '2026-1' }]);
    });

    test('новый клиент и услуга с оплатой: pending, код платежа и сумма 20% (D-010, D-016)', async () => {
      const r = await book({ serviceId: serviceB.id, variantId: serviceB.variants[0]!.id, startsAt: at(day, 11), phone: '+48 700 000 001' });
      assert.equal(r.status, 201);
      assert.equal(r.body.status, 'pending');
      assert.ok(r.body.holdExpiresAt);
      assert.equal(r.body.bookingFee.amount, 30);
      assert.equal(r.body.bookingFee.method, 'manual_blik');
      assert.match(r.body.bookingFee.code, /^[A-HJKMNP-Z2-9]{4}$/);
      const pr = await db.admin.query('SELECT amount, status FROM payment_requests WHERE booking_id = $1', [r.body.bookingId]);
      assert.deepEqual(pr.rows, [{ amount: '30.00', status: 'requested' }]);
    });

    test('не больше 2 заявок pending с одного номера у специалиста (D-044)', async () => {
      const phone = '+48 700 000 001';
      const second = await book({ serviceId: serviceB.id, variantId: serviceB.variants[0]!.id, startsAt: at(day, 13), phone });
      assert.equal(second.body.status, 'pending');
      const third = await book({ serviceId: serviceB.id, variantId: serviceB.variants[0]!.id, startsAt: at(day, 15), phone });
      assert.deepEqual([third.status, third.body], [409, { error: 'PENDING_LIMIT' }]);
    });

    test('клиент из blacklist видит нейтральное «нет мест»', async () => {
      const accountId = (await db.admin.query("SELECT account_id FROM staff WHERE public_slug = 'anna-test'")).rows[0].account_id;
      const hash = new PhoneHasher(TEST_CONFIG.phoneHashPepper).hash('+48700000099');
      await db.admin.query('INSERT INTO blacklist_entries (account_id, phone_hash) VALUES ($1, $2)', [accountId, hash]);
      const r = await book({ startsAt: at(day, 14), phone: '700 000 099' });
      assert.deepEqual([r.status, r.body], [409, { error: 'NO_FREE_SLOTS' }]);
      const left = await db.admin.query('SELECT count(*)::int AS n FROM clients WHERE phone_hash = $1', [hash]);
      assert.equal(left.rows[0].n, 0, 'при отказе транзакция откатывается целиком');
    });

    test('мастер видит заявки и подтверждает; после визита клиент доверенный и пишется без оплаты', async () => {
      const from = zonedToUtc(day, 0, WAW)!.toISOString();
      const to = zonedToUtc(addDays(day, 1), 0, WAW)!.toISOString();
      const list = await master.get(`/bookings?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      assert.equal(list.body.length, 3);
      const pending = list.body.find((b: { status: string; startsAt: string }) => b.status === 'pending' && b.startsAt === at(day, 11));

      const confirmed = await master.post(`/bookings/${pending.id}/transition`, { to: 'confirmed', expectedVersion: pending.version });
      assert.equal(confirmed.body.status, 'confirmed');
      const stale = await master.post(`/bookings/${pending.id}/transition`, { to: 'completed', expectedVersion: pending.version });
      assert.deepEqual([stale.status, stale.body], [409, { error: 'VERSION_CONFLICT' }]);
      assert.equal((await master.post(`/bookings/${pending.id}/transition`, { to: 'completed' })).body.status, 'completed');

      const again = await book({ serviceId: serviceB.id, variantId: serviceB.variants[0]!.id, startsAt: at(day, 15), phone: '700000001' });
      assert.equal(again.body.status, 'confirmed');
      assert.equal(again.body.bookingFee, null);
    });

    test('выход отзывает сессию на сервере', async () => {
      const oldCookie = master.clone();
      assert.equal((await master.post('/auth/logout')).status, 204);
      assert.equal((await master.get('/auth/me')).status, 401);
      assert.equal((await oldCookie.get('/auth/me')).status, 401);
    });
  });
});
