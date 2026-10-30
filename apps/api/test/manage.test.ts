import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { paymentOutcome } from '../src/bookings/payments';
import { ManageTokens } from '../src/public/manage-token';
import { Client, TEST_CONFIG, TEST_OTP, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';
import { slotWithinDay } from './helpers/time';

const PASSWORD = 'very secret 123';
const HOUR = 3_600_000;

describe('судьба оплаты (D-013)', () => {
  test('исходы по статусу, дедлайну и правилу политики', () => {
    assert.equal(paymentOutcome('confirmed', false, 'keep'), 'confirmed');
    assert.equal(paymentOutcome('cancelled_by_master', true, 'keep'), 'returned');
    assert.equal(paymentOutcome('cancelled_by_client', false, 'keep'), 'returned');
    assert.equal(paymentOutcome('cancelled_by_client', true, 'keep'), 'kept');
    assert.equal(paymentOutcome('cancelled_by_client', true, 'transfer'), 'kept');
    assert.equal(paymentOutcome('cancelled_by_client', true, 'refund'), 'returned');
    assert.equal(paymentOutcome('no_show', false, 'keep'), 'kept');
    assert.equal(paymentOutcome('no_show', false, 'refund'), 'returned');
    assert.equal(paymentOutcome('rescheduled', false, 'keep'), null);
  });
});

describe('токен ссылки управления', () => {
  const tokens = new ManageTokens(Buffer.alloc(32, 1));
  const a = '11111111-2222-4333-8444-555555555555';
  const b = '66666666-7777-4888-9999-aaaaaaaaaaaa';

  test('подписанный токен разбирается обратно, подделка и чужой ключ отклоняются', () => {
    const token = tokens.issue(a, b);
    assert.deepEqual(tokens.verify(token), { accountId: a, bookingId: b });
    const [v, payload, mac] = token.split('.') as [string, string, string];
    const swapped = Buffer.from(payload, 'base64url');
    swapped.writeUInt8(swapped.readUInt8(31) ^ 1, 31);
    assert.equal(tokens.verify(`${v}.${swapped.toString('base64url')}.${mac}`), null);
    assert.equal(tokens.verify(`${v}.${payload}.${mac.slice(0, -2)}AA`), null);
    assert.equal(new ManageTokens(Buffer.alloc(32, 2)).verify(token), null);
    for (const junk of ['', 'v1', 'v1..', 'v2.x.y', 'v1.%%%.%%%']) assert.equal(tokens.verify(junk), null, junk);
  });

  test('принимается только каноническая запись токена (лишние биты последнего символа)', () => {
    const token = tokens.issue(a, b);
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const accepted = [...alphabet].map((ch) => token.slice(0, -1) + ch).filter((variant) => tokens.verify(variant) !== null);
    assert.deepEqual(accepted, [token]);
  });
});

describe('HTTP: перенос и отмена клиентом по ссылке (BOOKING_FLOW.md, раздел 5)', () => {
  let db: TestDb;
  let t: TestApp;
  let master: Client;
  let anon: Client;
  let free: { id: string; variants: Array<{ id: string }> };
  let paid: { id: string; variants: Array<{ id: string }> };
  let phoneSeq = 0;

  // Сетка слотов идёт от местной полуночи с шагом 15 минут. Запас 4 часа до полуночи: тесты переносят запись
  // до +2 часов, визит 60 минут, иначе вечерний запуск уводил перенос за конец рабочего дня (409).
  const slotAt = (msFromNow: number) => slotWithinDay(msFromNow, 'Europe/Warsaw', 4 * 60);
  const book = async (service: typeof free, startsAt: Date) => {
    phoneSeq += 1;
    const r = await anon.post('/public/staff/manage-me/bookings', {
      serviceId: service.id,
      variantId: service.variants[0]!.id,
      startsAt: startsAt.toISOString(),
      name: 'Klient',
      phone: `+4870000${String(phoneSeq).padStart(4, '0')}`,
      otpCode: TEST_OTP,
      acceptTerms: true,
      acceptPrivacy: true,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as { bookingId: string; status: string; manageToken: string };
  };
  const payment = async (bookingId: string) =>
    (await db.admin.query('SELECT status FROM payment_requests WHERE booking_id = $1', [bookingId])).rows[0]?.status;

  before(async () => {
    db = await createTestDb('manage');
    t = await createTestApp(db);
    anon = new Client(t.url);
    master = new Client(t.url);
    await db.admin.query("INSERT INTO consent_documents (type, language, version, body) VALUES ('terms', 'pl', '1', 'R'), ('privacy', 'pl', '1', 'P')");
    await createMaster(db.app, { accountName: 'Studio', email: 'm@manage.pl', password: PASSWORD });
    await master.post('/auth/login', { email: 'm@manage.pl', password: PASSWORD });
    await master.patch('/account/payment', { blikPhone: '600700800', recipient: 'Studio' });
    const staffId = (await master.post('/staff', { displayName: 'Iza', publicSlug: 'manage-me' })).body.id;
    const policy = (await master.post('/policies', { freeCancelHours: 24, maxReschedules: 1, depositOnLateCancel: 'keep' })).body.id;
    free = (await master.post('/services', {
      name: { pl: 'Konsultacja' },
      requiresManualConfirm: false,
      cancelPolicyId: policy,
      variants: [{ durationMin: 60, price: 100 }],
    })).body.service;
    paid = (await master.post('/services', {
      name: { pl: 'Tatuaż' },
      prepaymentMethod: 'manual_blik',
      depositMode: 'percent',
      depositValue: 20,
      cancelPolicyId: policy,
      variants: [{ durationMin: 60, price: 500 }],
    })).body.service;
    for (const s of [free, paid]) await master.put(`/staff/${staffId}/services/${s.id}`);
    // Круглосуточно, чтобы тест не зависел от времени запуска.
    await master.put(`/staff/${staffId}/working-hours`, { intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })) });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('неверный или чужой токен = 404', async () => {
    const b = await book(free, slotAt(3 * 24 * HOUR));
    assert.equal((await anon.get(`/public/bookings/${b.manageToken.slice(0, -1)}x`)).status, 404);
    assert.equal((await anon.get('/public/bookings/garbage')).status, 404);
    // Подпись верна, но запись другого Account: под RLS её нет.
    const other = await createMaster(db.app, { accountName: 'Other', email: 'o@manage.pl', password: PASSWORD });
    const forged = new ManageTokens(TEST_CONFIG.fieldMasterKey).issue(other.accountId, b.bookingId);
    assert.equal((await anon.get(`/public/bookings/${forged}`)).status, 404);
  });

  test('до дедлайна: видны правила, можно отменить и перенести', async () => {
    const start = slotAt(10 * 24 * HOUR);
    const b = await book(free, start);
    const view = (await anon.get(`/public/bookings/${b.manageToken}`)).body;
    assert.equal(view.status, 'confirmed');
    assert.deepEqual([view.canCancel, view.lateCancel, view.canReschedule, view.contactMaster], [true, false, true, false]);
    assert.deepEqual(view.policy, { freeCancelHours: 24, maxReschedules: 1, rescheduleCount: 0, deadline: new Date(start.getTime() - 24 * HOUR).toISOString() });
    assert.deepEqual(view.service, { pl: 'Konsultacja' });
  });

  test('перенос на пересекающееся время, оплата и снимок политики переходят; лимит переносов из снимка (D-015)', async () => {
    const start = slotAt(12 * 24 * HOUR);
    const b = await book(free, start);
    const shifted = new Date(start.getTime() + 30 * 60_000);
    const day = start.toISOString().slice(0, 10);
    const slots = (await anon.get(`/public/bookings/${b.manageToken}/slots?from=${day}&to=${day}`)).body.slots;
    assert.ok(slots.includes(shifted.toISOString()), 'своя запись не блокирует соседнее время');

    const moved = await anon.post(`/public/bookings/${b.manageToken}/reschedule`, { startsAt: shifted.toISOString() });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal(moved.body.status, 'confirmed');
    assert.equal(moved.body.startsAt, shifted.toISOString());

    const old = (await anon.get(`/public/bookings/${b.manageToken}`)).body;
    assert.equal(old.status, 'rescheduled');
    assert.equal(old.rescheduledToToken, moved.body.token);
    const rows = await db.admin.query('SELECT reschedule_count, rescheduled_from, policy_version FROM bookings WHERE rescheduled_from = $1', [b.bookingId]);
    assert.deepEqual(rows.rows, [{ reschedule_count: 1, rescheduled_from: b.bookingId, policy_version: 1 }]);

    // Мастер разрешает больше переносов новой политикой, но запись живёт по снимку на момент бронирования.
    const v2 = (await master.post('/policies', { maxReschedules: 5 })).body.id;
    await master.patch(`/services/${free.id}`, { cancelPolicyId: v2 });
    const again = await anon.post(`/public/bookings/${moved.body.token}/reschedule`, { startsAt: new Date(shifted.getTime() + HOUR).toISOString() });
    assert.deepEqual([again.status, again.body], [409, { error: 'RESCHEDULE_LIMIT' }]);
  });

  test('ранняя отмена оплаченной записи: оплата к возврату', async () => {
    const b = await book(paid, slotAt(9 * 24 * HOUR));
    assert.equal(b.status, 'pending');
    assert.deepEqual((await anon.post(`/public/bookings/${b.manageToken}/reschedule`, { startsAt: slotAt(9 * 24 * HOUR + 2 * HOUR).toISOString() })).body, {
      error: 'NOT_RESCHEDULABLE',
    });
    assert.equal((await master.post(`/bookings/${b.bookingId}/transition`, { to: 'confirmed' })).status, 201);
    assert.equal(await payment(b.bookingId), 'confirmed', 'мастер одобрил заявку = перевод проверен');

    const cancelled = await anon.post(`/public/bookings/${b.manageToken}/cancel`);
    assert.deepEqual(cancelled.body, { status: 'cancelled_by_client', late: false, payment: 'returned' });
    assert.deepEqual((await anon.post(`/public/bookings/${b.manageToken}/cancel`)).body, { error: 'NOT_CANCELLABLE' });
  });

  test('после дедлайна: переноса нет, «связаться с мастером», отмена оставляет оплату мастеру', async () => {
    // Позже дедлайна (24 ч), но не раньше minLead (2 ч), и визит не переходит через полночь.
    const start = slotWithinDay(3 * HOUR);
    const b = await book(paid, start);
    await master.post(`/bookings/${b.bookingId}/transition`, { to: 'confirmed' });
    const view = (await anon.get(`/public/bookings/${b.manageToken}`)).body;
    assert.deepEqual([view.canCancel, view.lateCancel, view.canReschedule, view.contactMaster], [true, true, false, true]);
    assert.equal(view.bookingFee.status, 'confirmed');
    assert.equal(view.bookingFee.blikPhone, '+48600700800');

    const late = await anon.post(`/public/bookings/${b.manageToken}/reschedule`, { startsAt: new Date(start.getTime() + HOUR).toISOString() });
    assert.deepEqual(late.body, { error: 'RESCHEDULE_TOO_LATE' });
    assert.deepEqual((await anon.post(`/public/bookings/${b.manageToken}/cancel`)).body, { status: 'cancelled_by_client', late: true, payment: 'kept' });
  });

  test('отмена мастером возвращает оплату, неявка оставляет', async () => {
    const a = await book(paid, slotAt(7 * 24 * HOUR));
    await master.post(`/bookings/${a.bookingId}/transition`, { to: 'confirmed' });
    await master.post(`/bookings/${a.bookingId}/transition`, { to: 'cancelled_by_master' });
    assert.equal(await payment(a.bookingId), 'returned');

    const b = await book(paid, slotAt(8 * 24 * HOUR));
    await master.post(`/bookings/${b.bookingId}/transition`, { to: 'confirmed' });
    await master.post(`/bookings/${b.bookingId}/transition`, { to: 'no_show' });
    assert.equal(await payment(b.bookingId), 'kept');
  });

  test('перенос оплаченной записи не создаёт повторного платежа', async () => {
    const start = slotAt(15 * 24 * HOUR);
    const b = await book(paid, start);
    await master.post(`/bookings/${b.bookingId}/transition`, { to: 'confirmed' });
    const moved = await anon.post(`/public/bookings/${b.manageToken}/reschedule`, { startsAt: new Date(start.getTime() + 2 * HOUR).toISOString() });
    assert.equal(moved.status, 200);
    const fee = (await anon.get(`/public/bookings/${moved.body.token}`)).body.bookingFee;
    assert.equal(fee.status, 'confirmed');
    const count = await db.admin.query(
      'SELECT count(*)::int AS n FROM payment_requests pr JOIN bookings b ON b.id = pr.booking_id WHERE b.id = $1 OR b.rescheduled_from = $1',
      [b.bookingId],
    );
    assert.equal(count.rows[0].n, 1);
  });

  test('«записаться снова» и «добавить в календарь»: услуга в ответе, .ics только для действующей записи', async () => {
    const b = await book(free, slotAt(16 * 24 * HOUR));
    const view = (await anon.get(`/public/bookings/${b.manageToken}`)).body;
    assert.deepEqual([view.serviceId, view.variantId], [free.id, free.variants[0]!.id]);

    const ics = await anon.get(`/public/bookings/${b.manageToken}/ics?lang=pl`);
    assert.equal(ics.status, 200);
    assert.match(ics.headers.get('content-type') ?? '', /text\/calendar/);
    assert.match(ics.headers.get('content-disposition') ?? '', /attachment; filename="rezerwacja\.ics"/);
    assert.match(ics.body, /SUMMARY:Konsultacja · Iza\r\n/);
    assert.match(ics.body, /STATUS:CONFIRMED/);
    // Длинные строки по RFC 5545 перенесены (CRLF + пробел): ищем в склеенном тексте.
    assert.ok(ics.body.replace(/\r\n /g, '').includes(`/b/${b.manageToken}?lang=pl`), 'в описании ссылка управления записью');

    await anon.post(`/public/bookings/${b.manageToken}/cancel`);
    assert.deepEqual((await anon.get(`/public/bookings/${b.manageToken}/ics`)).body, { error: 'NOT_ACTIVE' });
    assert.equal((await anon.get(`/public/bookings/${b.manageToken.slice(0, -2)}AA/ics`)).status, 404);
  });
});
