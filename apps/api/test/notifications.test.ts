import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Redis } from 'ioredis';
import { createMaster } from '../src/auth/auth.service';
import { addDays, localDate, zonedToUtc } from '../src/availability/zoned-time';
import { BookingsService } from '../src/bookings/bookings.service';
import { ClientsService } from '../src/clients/clients.service';
import { CrmService } from '../src/clients/crm.service';
import { FieldCipher } from '../src/crypto/field-cipher';
import { EnvKeyProvider } from '../src/crypto/key-provider';
import { PhoneHasher } from '../src/crypto/phone-hash';
import { MaintenanceJobs } from '../src/jobs/maintenance';
import type { BookingNotification } from '../src/jobs/notifier';
import { JobScheduler } from '../src/jobs/scheduler';
import { SandboxChannel, type Channel, type ChannelAdapter, type Contact, type OutgoingMessage } from '../src/notifications/channels';
import { NotificationDispatcher, formatWhen } from '../src/notifications/dispatcher';
import { QueueNotifier } from '../src/notifications/queue';
import { ManageTokens } from '../src/public/manage-token';
import { Client, RecordingNotifier, TEST_CONFIG, TEST_OTP, TEST_REDIS_URL, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const WAW = 'Europe/Warsaw';

/** «Настоящий» адаптер (не песочница): запоминает сообщения, может падать по команде. */
class FakeChannel implements ChannelAdapter {
  readonly sandbox = false;
  readonly sent: OutgoingMessage[] = [];
  failing = false;
  constructor(readonly channel: Channel) {}
  reachable(c: Contact): boolean {
    return this.channel === 'email' ? c.email !== null : c.phone !== null;
  }
  async send(m: OutgoingMessage): Promise<{ cost: number | null }> {
    if (this.failing) throw new TypeError(`provider down for ${m.to.phone ?? m.to.email}`);
    this.sent.push(m);
    return { cost: this.channel === 'sms' ? 0.07 : null };
  }
}

describe('уведомления (D-035, D-052)', () => {
  let db: TestDb;
  let t: TestApp;
  let master: Client;
  let anon: Client;
  let accountId: string;
  let ownerId: string;
  let service: { id: string; variants: Array<{ id: string }> };
  let paid: { id: string; variants: Array<{ id: string }> };
  let email: FakeChannel;
  let sms: FakeChannel;
  let quotaEvents: RecordingNotifier;
  let dispatcher: NotificationDispatcher;
  let phoneSeq = 0;
  const day = addDays(localDate(new Date(), WAW), 6);
  const at = (h: number, d = day) => zonedToUtc(d, h * 60, WAW)!;
  const cipher = new FieldCipher(new EnvKeyProvider(TEST_CONFIG.fieldMasterKey));
  const tokens = new ManageTokens(TEST_CONFIG.fieldMasterKey);

  const book = async (svc: typeof service, startsAt: Date, extra: Record<string, unknown> = {}) => {
    phoneSeq += 1;
    await t.resetRateLimits();
    const r = await anon.post('/public/staff/notify-me/bookings', {
      serviceId: svc.id,
      variantId: svc.variants[0]!.id,
      startsAt: startsAt.toISOString(),
      name: `Klientka ${phoneSeq}`,
      phone: `+4878000${String(phoneSeq).padStart(4, '0')}`,
      otpCode: TEST_OTP,
      acceptTerms: true,
      acceptPrivacy: true,
      ...extra,
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body as { bookingId: string; status: string; manageToken: string };
  };
  const lastEvent = (type: BookingNotification['type']) => [...t.notifications.events].reverse().find((e) => e.type === type)!;
  const logRows = (bookingId: string) =>
    db.admin.query('SELECT recipient_kind, template, channel, status, reason, attempts FROM notification_log WHERE booking_id = $1 ORDER BY recipient_kind', [bookingId]);

  before(async () => {
    db = await createTestDb('notify');
    t = await createTestApp(db);
    anon = new Client(t.url);
    master = new Client(t.url);
    await db.admin.query("INSERT INTO consent_documents (type, language, version, body) VALUES ('terms', 'pl', '1', 'R'), ('privacy', 'pl', '1', 'P')");
    ({ accountId, userId: ownerId } = await createMaster(db.app, { accountName: 'Studio', email: 'owner@notify.pl', password: PASSWORD }));
    await master.post('/auth/login', { email: 'owner@notify.pl', password: PASSWORD });
    await master.patch('/account/payment', { blikPhone: '600700800' });
    const staffId = (await master.post('/staff', { displayName: 'Marta', publicSlug: 'notify-me' })).body.id;
    service = (await master.post('/services', { name: { pl: 'Manicure', uk: 'Манікюр' }, requiresManualConfirm: false, variants: [{ durationMin: 60, price: 100 }] })).body.service;
    paid = (await master.post('/services', { name: { pl: 'Hybryda' }, prepaymentMethod: 'manual_blik', depositMode: 'fixed', depositValue: 30, variants: [{ durationMin: 60, price: 120 }] })).body.service;
    for (const s of [service, paid]) await master.put(`/staff/${staffId}/services/${s.id}`);
    await master.put(`/staff/${staffId}/working-hours`, { intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '00:00', end: '24:00' })) });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  const fresh = () => {
    email = new FakeChannel('email');
    sms = new FakeChannel('sms');
    quotaEvents = new RecordingNotifier();
    dispatcher = new NotificationDispatcher(db.app, cipher, tokens, [sms, email], TEST_CONFIG.publicUrl, quotaEvents);
  };

  test('заявка с оплатой: клиенту SMS с инструкцией и ссылкой, мастеру email; журнал без текста', async () => {
    fresh();
    const b = await book(paid, at(10));
    const event = lastEvent('booking.created');
    assert.deepEqual(event, { type: 'booking.created', accountId, bookingId: b.bookingId, status: 'pending' });

    const results = await dispatcher.dispatch(event);
    assert.deepEqual(results.map((r) => [r.kind, r.template, r.status, r.channel]).sort(), [
      ['client', 'notify.client.request_received', 'sent', 'sms'],
      ['user', 'notify.master.new_request', 'sent', 'email'],
    ]);
    const toClient = sms.sent[0]!;
    assert.equal(toClient.to.phone, `+4878000${String(phoneSeq).padStart(4, '0')}`);
    assert.ok(toClient.text.startsWith(`Zgłoszenie przyjęte: Hybryda u Marta, ${formatWhen(at(10), WAW, 'pl')}.`), toClient.text);
    assert.ok(toClient.text.includes(`https://rezerw.test/b/${b.manageToken}`));
    assert.match(toClient.text, /wpłać 30 PLN przez BLIK na numer \+48600700800\. W tytule wpisz kod: [A-Z2-9]{4}\./);
    const toMaster = email.sent[0]!;
    assert.equal(toMaster.to.email, 'owner@notify.pl');
    assert.equal(toMaster.subject, 'RezerwApp: Marta');
    assert.ok(toMaster.text.includes(`klient Klientka ${phoneSeq}`));

    const cols = await db.admin.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'notification_log'");
    assert.ok(!cols.rows.some((c) => /text|body|content|message/.test(c.column_name)), 'в журнале нет текста сообщений');
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM sms_ledger WHERE reason = 'sent:notify.client.request_received'")).rows[0].n, 1);
  });

  test('повтор того же события ничего не отправляет второй раз', async () => {
    fresh();
    const b = await book(service, at(12));
    const event = lastEvent('booking.created');
    await dispatcher.dispatch(event);
    const again = await dispatcher.dispatch(event);
    assert.equal(sms.sent.length + email.sent.length, 2);
    assert.ok(again.every((r) => r.status === 'sent'));
    assert.deepEqual((await logRows(b.bookingId)).rows.map((r) => r.attempts), [1, 1]);
  });

  test('язык клиента и порядок каналов: при наличии email он раньше SMS (D-035)', async () => {
    fresh();
    const b = await book(service, at(14), { language: 'uk' });
    const clientId = (await db.admin.query('SELECT client_id FROM bookings WHERE id = $1', [b.bookingId])).rows[0].client_id;
    await master.patch(`/clients/${clientId}`, { email: 'olena@example.ua' });
    await dispatcher.dispatch(lastEvent('booking.created'));
    const toClient = email.sent.find((m) => m.to.email === 'olena@example.ua')!;
    assert.ok(toClient.text.startsWith(`Запис підтверджено: Манікюр у Marta, ${formatWhen(at(14), WAW, 'uk')}.`), toClient.text);
    assert.equal(sms.sent.length, 0);
  });

  test('сбой канала: запасной канал; все каналы упали = failed и повтор задачи доставляет один раз', async () => {
    fresh();
    const b = await book(service, at(16));
    const clientId = (await db.admin.query('SELECT client_id FROM bookings WHERE id = $1', [b.bookingId])).rows[0].client_id;
    await master.patch(`/clients/${clientId}`, { email: 'k@example.pl' });
    const event = lastEvent('booking.created');
    email.failing = true;
    sms.failing = true;
    await assert.rejects(dispatcher.dispatch(event), /2 of 2 deliveries failed/);
    const failed = (await logRows(b.bookingId)).rows;
    assert.deepEqual(failed.map((r) => [r.status, r.reason]), [['failed', 'TypeError'], ['failed', 'TypeError']]);

    email.failing = false; // email снова работает, SMS нет: клиенту уходит email
    await dispatcher.dispatch(event);
    assert.deepEqual((await logRows(b.bookingId)).rows.map((r) => [r.status, r.channel, r.attempts]), [['sent', 'email', 2], ['sent', 'email', 2]]);
  });

  test('лимит SMS: предупреждение на 80% один раз, после исчерпания SMS не уходит (D-003)', async () => {
    fresh();
    const used = (await db.admin.query("SELECT count(*)::int AS n FROM sms_ledger WHERE account_id = $1", [accountId])).rows[0].n;
    await db.admin.query('UPDATE accounts SET sms_included = $2 WHERE id = $1', [accountId, used + 5]);
    const outcomes = [];
    for (let i = 0; i < 6; i += 1) {
      const b = await book(service, at(1 + i, addDays(day, 1)));
      const r = await dispatcher.dispatch(lastEvent('booking.created'));
      outcomes.push(r.find((x) => x.kind === 'client')!.status);
      if (i === 5) assert.equal((await logRows(b.bookingId)).rows.find((x) => x.recipient_kind === 'client').reason, 'sms_quota');
    }
    assert.deepEqual(outcomes, ['sent', 'sent', 'sent', 'sent', 'sent', 'skipped']);
    assert.deepEqual(quotaEvents.events.map((e) => e.type), ['account.sms_quota']);

    const quota = quotaEvents.events[0]!;
    await dispatcher.dispatch(quota);
    assert.ok(email.sent.some((m) => m.text.includes('limitu SMS') && m.to.email === 'owner@notify.pl'));
    await db.admin.query('UPDATE accounts SET sms_included = 40 WHERE id = $1', [accountId]);
  });

  test('песочница: путь доставки пройден, статус sandbox, SMS не списываются', async () => {
    const sandbox = new NotificationDispatcher(db.app, cipher, tokens, [new SandboxChannel('email'), new SandboxChannel('sms')], TEST_CONFIG.publicUrl);
    const before = (await db.admin.query('SELECT count(*)::int AS n FROM sms_ledger')).rows[0].n;
    const b = await book(service, at(18));
    await sandbox.dispatch(lastEvent('booking.created'));
    assert.deepEqual((await logRows(b.bookingId)).rows.map((r) => [r.status, r.channel]), [['sandbox', 'sms'], ['sandbox', 'email']]);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM sms_ledger')).rows[0].n, before);
  });

  test('действия мастера порождают событие; устаревшее событие не отправляется', async () => {
    fresh();
    const b = await book(paid, at(20));
    await master.post(`/bookings/${b.bookingId}/transition`, { to: 'confirmed' });
    const confirmed = lastEvent('booking.status_changed');
    assert.deepEqual(confirmed, { type: 'booking.status_changed', accountId, bookingId: b.bookingId, to: 'confirmed' });
    await master.post(`/bookings/${b.bookingId}/transition`, { to: 'cancelled_by_master' });

    assert.deepEqual(await dispatcher.dispatch(confirmed), [], 'запись уже отменена: «подтверждено» не шлём');
    const cancelled = await dispatcher.dispatch(lastEvent('booking.status_changed'));
    assert.deepEqual(cancelled.map((r) => r.template), ['notify.client.cancelled_by_master']);
    assert.ok(sms.sent[0]!.text.includes('https://rezerw.test/notify-me'), 'ссылка на страницу специалиста для новой записи');
  });

  test('напоминание клиенту за 24 часа: один раз, не для записей, сделанных менее чем за сутки', async () => {
    const soon = new Date(Math.ceil((Date.now() + 20 * 3_600_000) / 900_000) * 900_000);
    const early = await book(service, soon);
    const late = await book(service, new Date(soon.getTime() + 2 * 3_600_000));
    await db.admin.query("UPDATE bookings SET created_at = now() - interval '3 days' WHERE id = $1", [early.bookingId]);

    const hasher = new PhoneHasher(TEST_CONFIG.phoneHashPepper);
    const bookings = new BookingsService(db.app);
    const recorder = new RecordingNotifier();
    const jobs = new MaintenanceJobs(db.app, bookings, new CrmService(db.app, new ClientsService(hasher, cipher), hasher, cipher), recorder);
    const first = await jobs.run();
    const second = await jobs.run();
    assert.equal(first.clientReminded, 1);
    assert.equal(second.clientReminded, 0);
    assert.deepEqual(recorder.events.filter((e) => e.type === 'booking.client_reminder').map((e) => ('bookingId' in e ? e.bookingId : null)), [early.bookingId]);
    assert.ok(!recorder.events.some((e) => 'bookingId' in e && e.bookingId === late.bookingId));

    fresh();
    await dispatcher.dispatch(recorder.events.find((e) => e.type === 'booking.client_reminder')!);
    assert.ok(sms.sent[0]!.text.startsWith('Przypomnienie: Manicure u Marta'));
  });

  test('очередь BullMQ: событие из QueueNotifier доставляется воркером', async () => {
    const prefix = `test-bull-${randomBytes(4).toString('hex')}`;
    const sandbox = new NotificationDispatcher(db.app, cipher, tokens, [new SandboxChannel('email'), new SandboxChannel('sms')], TEST_CONFIG.publicUrl);
    const hasher = new PhoneHasher(TEST_CONFIG.phoneHashPepper);
    const jobs = new MaintenanceJobs(db.app, new BookingsService(db.app), new CrmService(db.app, new ClientsService(hasher, cipher), hasher, cipher), new RecordingNotifier());
    const scheduler = new JobScheduler(jobs, { redisUrl: TEST_REDIS_URL, prefix, everyMs: 60_000 }, sandbox);
    const queue = new QueueNotifier(TEST_REDIS_URL, prefix);
    await scheduler.onApplicationBootstrap();
    try {
      const b = await book(service, at(22));
      await queue.notify(lastEvent('booking.created'));
      await queue.notify(lastEvent('booking.created')); // дубль в очереди схлопывается по jobId
      let rows: Array<{ status: string }> = [];
      for (let i = 0; i < 100 && rows.length < 2; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        rows = (await logRows(b.bookingId)).rows.filter((r) => r.status === 'sandbox');
      }
      assert.equal(rows.length, 2);
      assert.ok((await logRows(b.bookingId)).rows.every((r) => r.attempts === 1));
    } finally {
      await queue.close();
      await scheduler.onApplicationShutdown();
      const redis = new Redis(TEST_REDIS_URL);
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
  });

  test('повреждённый шифротекст телефона не блокирует остальные доставки события', async () => {
    fresh();
    const b = await book(service, at(23));
    await db.admin.query("UPDATE clients SET phone_encrypted = '\\x01' WHERE id = (SELECT client_id FROM bookings WHERE id = $1)", [b.bookingId]);
    const results = await dispatcher.dispatch(lastEvent('booking.created'));
    assert.deepEqual(results.map((r) => [r.kind, r.status, r.channel]).sort(), [
      ['client', 'skipped', null],
      ['user', 'sent', 'email'],
    ]);
  });

  test('журнал уведомлений защищён RLS и не удаляется приложением', async () => {
    const other = await createMaster(db.app, { accountName: 'Other', email: 'o@notify.pl', password: PASSWORD });
    const seen = await db.app.withAccount(other.accountId, (c) => c.query('SELECT count(*)::int AS n FROM notification_log'));
    assert.equal(seen.rows[0].n, 0);
    await assert.rejects(db.app.withAccount(accountId, (c) => c.query('DELETE FROM notification_log')), /permission denied/);
    assert.ok(ownerId);
  });
});
