import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { BookingsService } from '../src/bookings/bookings.service';
import { FieldCipher } from '../src/crypto/field-cipher';
import { EnvKeyProvider } from '../src/crypto/key-provider';
import type { Channel, ChannelAdapter, Contact, OutgoingMessage } from '../src/notifications/channels';
import { NotificationDispatcher } from '../src/notifications/dispatcher';
import { ManageTokens } from '../src/public/manage-token';
import { Client, TEST_CONFIG, TEST_OTP, createTestApp, inviteUser, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';
import { slotWithinDay } from './helpers/time';

const PASSWORD = 'very secret 123';
const DAY = 86_400_000;

class CapturingChannel implements ChannelAdapter {
  readonly sandbox = false;
  readonly sent: OutgoingMessage[] = [];
  constructor(readonly channel: Channel) {}
  reachable(c: Contact): boolean {
    return c.phone !== null;
  }
  async send(m: OutgoingMessage): Promise<{ cost: number | null }> {
    this.sent.push(m);
    return { cost: null };
  }
}

describe('возврат резервационной оплаты (D-072)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let ola: Client;
  let ewa: Client;
  let desk: Client;
  let anon: Client;
  let accountId: string;
  let paid: { id: string; variants: Array<{ id: string }> };
  let seq = 0;

  const login = async (email: string) => {
    const c = new Client(t.url);
    assert.equal((await c.post('/auth/login', { email, password: PASSWORD })).status, 200, email);
    return c;
  };
  /** Заявка с оплатой (pending, оплата requested). */
  const request = async () => {
    seq += 1;
    await t.resetRateLimits();
    const r = await anon.post('/public/staff/r-ola/bookings', {
      serviceId: paid.id,
      variantId: paid.variants[0]!.id,
      startsAt: slotWithinDay((3 + seq) * DAY).toISOString(),
      name: 'Klientka',
      phone: `+4856000${String(seq).padStart(4, '0')}`,
      otpCode: TEST_OTP,
      acceptTerms: true,
      acceptPrivacy: true,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'pending');
    return r.body as { bookingId: string; manageToken: string };
  };
  const payment = async (bookingId: string) =>
    (await db.admin.query('SELECT status, settled_at FROM payment_requests WHERE booking_id = $1', [bookingId])).rows[0];
  const due = async (who: Client) => ((await who.get('/bookings/payments-due')).body as Array<{ id: string; payment: { status: string } }>);

  before(async () => {
    db = await createTestDb('refunds');
    t = await createTestApp(db);
    anon = new Client(t.url);
    await db.admin.query("INSERT INTO consent_documents (type, language, version, body) VALUES ('terms', 'pl', '1', 'R'), ('privacy', 'pl', '1', 'P')");
    ({ accountId } = await createMaster(db.app, { accountName: 'Studio', email: 'owner@r.pl', password: PASSWORD }));
    owner = await login('owner@r.pl');
    const olaStaff = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'r-ola' })).body.id;
    const ewaStaff = (await owner.post('/staff', { displayName: 'Ewa', publicSlug: 'r-ewa' })).body.id;
    await inviteUser(t.url, owner, { email: 'ola@r.pl', role: 'staff', staffId: olaStaff }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'ewa@r.pl', role: 'staff', staffId: ewaStaff }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'desk@r.pl', role: 'assistant' }, PASSWORD);
    ola = await login('ola@r.pl');
    ewa = await login('ewa@r.pl');
    desk = await login('desk@r.pl');
    await owner.patch('/account/payment', { blikPhone: '600700800' });
    paid = (await owner.post('/services', {
      name: { pl: 'Rzęsy' },
      prepaymentMethod: 'manual_blik',
      depositMode: 'fixed',
      depositValue: 40,
      depositScope: 'all',
      variants: [{ durationMin: 60, price: 200 }],
    })).body.service;
    await owner.put(`/staff/${olaStaff}/services/${paid.id}`);
    await owner.put(`/staff/${olaStaff}/working-hours`, { intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })) });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('отклонение до подтверждения оплаты: «проверить и вернуть»; мастер отмечает, что перевода не было', async () => {
    const b = await request();
    await owner.post(`/bookings/${b.bookingId}/transition`, { to: 'rejected' });
    assert.equal((await payment(b.bookingId)).status, 'to_check');
    assert.deepEqual((await due(owner)).map((x) => [x.id, x.payment.status]), [[b.bookingId, 'to_check']]);
    assert.deepEqual((await due(ola)).map((x) => x.id), [b.bookingId]);
    assert.deepEqual(await due(ewa), [], 'чужие записи не видны');

    assert.equal((await ewa.post(`/bookings/${b.bookingId}/payment`, { result: 'not_received' })).status, 403);
    assert.equal((await desk.post(`/bookings/${b.bookingId}/payment`, { result: 'not_received' })).status, 403);
    assert.equal((await ola.post(`/bookings/${b.bookingId}/payment`, { result: 'not_received' })).status, 204);
    const p = await payment(b.bookingId);
    assert.equal(p.status, 'not_received');
    assert.ok(p.settled_at instanceof Date);
    assert.deepEqual(await due(owner), []);
    assert.deepEqual((await ola.post(`/bookings/${b.bookingId}/payment`, { result: 'refunded' })).body, { error: 'PAYMENT_NOT_DUE' });
  });

  test('истечение заявки и отмена клиентом до подтверждения оплаты: тоже «проверить и вернуть»', async () => {
    const expired = await request();
    await db.admin.query("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [expired.bookingId]);
    await new BookingsService(db.app).expireStale(accountId);
    assert.equal((await payment(expired.bookingId)).status, 'to_check');

    const cancelled = await request();
    const r = await anon.post(`/public/bookings/${cancelled.manageToken}/cancel`);
    assert.equal(r.body.payment, 'to_check');
    assert.equal((await payment(cancelled.bookingId)).status, 'to_check');
    for (const id of [expired.bookingId, cancelled.bookingId]) await owner.post(`/bookings/${id}/payment`, { result: 'refunded' });
  });

  test('истёкшая заявка, освобождённая новой записью на то же время: оплата тоже «проверить и вернуть»', async () => {
    const old = await request();
    const startsAt = (await db.admin.query('SELECT starts_at FROM bookings WHERE id = $1', [old.bookingId])).rows[0].starts_at as Date;
    await db.admin.query("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [old.bookingId]);
    await t.resetRateLimits();
    const taken = await anon.post('/public/staff/r-ola/bookings', {
      serviceId: paid.id,
      variantId: paid.variants[0]!.id,
      startsAt: startsAt.toISOString(),
      name: 'Inna',
      phone: '+48560999999',
      otpCode: TEST_OTP,
      acceptTerms: true,
      acceptPrivacy: true,
    });
    assert.equal(taken.status, 201, JSON.stringify(taken.body));
    assert.equal((await payment(old.bookingId)).status, 'to_check');
    await owner.post(`/bookings/${old.bookingId}/payment`, { result: 'not_received' });
  });

  test('подтверждённая оплата при отмене мастером: «вернуть»; отметка возврата уведомляет клиента', async () => {
    const b = await request();
    await owner.post(`/bookings/${b.bookingId}/transition`, { to: 'confirmed' });
    assert.equal((await payment(b.bookingId)).status, 'confirmed');
    await owner.post(`/bookings/${b.bookingId}/transition`, { to: 'cancelled_by_master' });
    assert.equal((await payment(b.bookingId)).status, 'returned');
    assert.deepEqual((await ola.post(`/bookings/${b.bookingId}/payment`, { result: 'not_received' })).body, { error: 'PAYMENT_NOT_DUE' }, 'получение было подтверждено');
    assert.equal((await ola.post(`/bookings/${b.bookingId}/payment`, { result: 'refunded' })).status, 204);
    assert.equal((await payment(b.bookingId)).status, 'refunded');
    assert.ok(t.notifications.events.some((e) => e.type === 'payment.refunded' && e.bookingId === b.bookingId));
    assert.equal((await anon.get(`/public/bookings/${b.manageToken}`)).body.bookingFee.status, 'refunded');
  });

  test('тексты клиенту: при отклонении фраза о возврате, при отметке возврата отдельное сообщение', async () => {
    const sms = new CapturingChannel('sms');
    const dispatcher = new NotificationDispatcher(db.app, new FieldCipher(new EnvKeyProvider(TEST_CONFIG.fieldMasterKey)), new ManageTokens(TEST_CONFIG.fieldMasterKey), [sms], TEST_CONFIG.publicUrl);
    const b = await request();
    await owner.post(`/bookings/${b.bookingId}/transition`, { to: 'rejected' });
    await dispatcher.dispatch({ type: 'booking.status_changed', accountId, bookingId: b.bookingId, to: 'rejected' });
    assert.match(sms.sent.at(-1)!.text, /specjalista ją zwróci/);
    await owner.post(`/bookings/${b.bookingId}/payment`, { result: 'refunded' });
    await dispatcher.dispatch({ type: 'payment.refunded', accountId, bookingId: b.bookingId });
    assert.match(sms.sent.at(-1)!.text, /zwrócił opłatę rezerwacyjną/);
  });

  test('ограничение БД: дата закрытия только у закрытых оплат', async () => {
    const b = await request();
    await assert.rejects(db.admin.query('UPDATE payment_requests SET settled_at = now() WHERE booking_id = $1', [b.bookingId]), /payment_requests_settled/);
    await assert.rejects(db.admin.query("UPDATE payment_requests SET status = 'refunded' WHERE booking_id = $1", [b.bookingId]), /payment_requests_settled/);
  });
});
