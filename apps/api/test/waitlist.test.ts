import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { AvailabilityService } from '../src/availability/availability.service';
import { addDays, localDate, zonedToUtc } from '../src/availability/zoned-time';
import { BookingsService } from '../src/bookings/bookings.service';
import { FieldCipher } from '../src/crypto/field-cipher';
import { EnvKeyProvider } from '../src/crypto/key-provider';
import type { Channel, ChannelAdapter, Contact, OutgoingMessage } from '../src/notifications/channels';
import { NotificationDispatcher } from '../src/notifications/dispatcher';
import { ManageTokens } from '../src/public/manage-token';
import { RateLimiter } from '../src/rate-limit';
import { WaitlistService, inPartOfDay } from '../src/waitlist/waitlist.service';
import { Client, TEST_CONFIG, TEST_OTP, createTestApp, inviteUser, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const WAW = 'Europe/Warsaw';
const MIN = 60_000;

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

describe('лист ожидания (D-068)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let ewa: Client;
  let anon: Client;
  let accountId: string;
  let olaStaff: string;
  let service: { id: string; variants: Array<{ id: string }> };
  let waitlist: WaitlistService;
  let bookings: BookingsService;
  const tokens = new ManageTokens(TEST_CONFIG.fieldMasterKey);
  // День D через два дня: у Оли рабочее время 10:00-11:00, визит 60 минут, значит, в день ровно один слот.
  const D = addDays(localDate(new Date(), WAW), 2);
  const at = (day: string, hour: number, minute = 0) => zonedToUtc(day, hour * 60 + minute, WAW)!;
  const noonBefore = at(addDays(D, -1), 12);
  let phoneSeq = 0;

  const login = async (email: string) => {
    const c = new Client(t.url);
    assert.equal((await c.post('/auth/login', { email, password: PASSWORD })).status, 200, email);
    return c;
  };
  const join = async (extra: Record<string, unknown> = {}) => {
    phoneSeq += 1;
    await t.resetRateLimits();
    return anon.post('/public/staff/w-ola/waitlist', {
      serviceId: service.id,
      variantId: service.variants[0]!.id,
      dateFrom: D,
      dateTo: D,
      name: `Klientka ${phoneSeq}`,
      phone: `+4853000${String(phoneSeq).padStart(4, '0')}`,
      otpCode: TEST_OTP,
      acceptTerms: true,
      acceptPrivacy: true,
      ...extra,
    });
  };
  const entryOf = async (token: string) => tokens.verifyWaitlist(token)!.entryId;
  const status = async (entryId: string) => (await db.admin.query('SELECT status FROM waitlist_entries WHERE id = $1', [entryId])).rows[0].status;
  const offersOf = async (entryId: string) =>
    (await db.admin.query('SELECT starts_at FROM waitlist_offers WHERE entry_id = $1 ORDER BY created_at', [entryId])).rows.map((r) => r.starts_at.toISOString());
  /** Занять единственный слот дня клиентом «Zajęte» и вернуть id записи. */
  const occupy = async (day: string) => {
    const r = await owner.post('/bookings', {
      staffId: olaStaff,
      serviceId: service.id,
      variantId: service.variants[0]!.id,
      startsAt: at(day, 10).toISOString(),
      client: { name: 'Zajęte', phone: `+4853999${day.slice(8)}00` },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.id as string;
  };

  before(async () => {
    db = await createTestDb('waitlist');
    t = await createTestApp(db);
    anon = new Client(t.url);
    bookings = new BookingsService(db.app);
    waitlist = new WaitlistService(db.app, new AvailabilityService(db.app), tokens, new RateLimiter(t.redis));
    await db.admin.query("INSERT INTO consent_documents (type, language, version, body) VALUES ('terms', 'pl', '1', 'R'), ('privacy', 'pl', '1', 'P')");
    ({ accountId } = await createMaster(db.app, { accountName: 'Studio', email: 'owner@w.pl', password: PASSWORD }));
    owner = await login('owner@w.pl');
    olaStaff = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'w-ola' })).body.id;
    const ewaStaff = (await owner.post('/staff', { displayName: 'Ewa', publicSlug: 'w-ewa' })).body.id;
    await inviteUser(t.url, owner, { email: 'ewa@w.pl', role: 'staff', staffId: ewaStaff }, PASSWORD);
    ewa = await login('ewa@w.pl');
    service = (await owner.post('/services', { name: { pl: 'Manicure' }, requiresManualConfirm: false, variants: [{ durationMin: 60, price: 100 }] })).body.service;
    await owner.put(`/staff/${olaStaff}/services/${service.id}`);
    await owner.put(`/staff/${olaStaff}/working-hours`, { intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '10:00', end: '11:00' })) });
    await owner.patch(`/staff/${olaStaff}/settings`, { minLeadMinutes: 0 });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('часть дня: утро до 12, день 12-17, вечер с 17', () => {
    assert.deepEqual([inPartOfDay(11 * 60 + 59, 'morning'), inPartOfDay(12 * 60, 'morning'), inPartOfDay(12 * 60, 'afternoon')], [true, false, true]);
    assert.deepEqual([inPartOfDay(17 * 60, 'afternoon'), inPartOfDay(17 * 60, 'evening'), inPartOfDay(3 * 60, 'any')], [false, true, true]);
  });

  test('постановка: проверка периода, согласий и кода; лимит очередей у клиента; подтверждение со ссылкой', async () => {
    const today = localDate(new Date(), WAW);
    assert.equal((await join({ dateFrom: addDays(today, -1), dateTo: today })).status, 400, 'в прошлом');
    assert.equal((await join({ dateFrom: today, dateTo: addDays(today, 31) })).status, 400, 'дольше 31 дня');
    assert.equal((await join({ dateFrom: addDays(today, 200), dateTo: addDays(today, 201) })).status, 400, 'дальше горизонта');
    assert.deepEqual((await join({ acceptTerms: false })).body, { error: 'CONSENT_REQUIRED' });
    assert.deepEqual((await join({ otpCode: '9999' })).body, { error: 'OTP_INVALID' });

    const phone = '+48530555555';
    for (let i = 0; i < 3; i += 1) assert.equal((await join({ phone, partOfDay: 'evening' })).status, 201);
    assert.deepEqual((await join({ phone })).body, { error: 'WAITLIST_LIMIT' });
    const ok = await join();
    assert.equal(ok.status, 201);
    const entryId = await entryOf(ok.body.waitlistToken);
    assert.ok(t.notifications.events.some((e) => e.type === 'waitlist.joined' && e.entryId === entryId));
    const view = (await anon.get(`/public/waitlist/${ok.body.waitlistToken}`)).body;
    assert.deepEqual([view.status, view.staffName, view.slug, view.dateFrom, view.partOfDay, view.offer], ['waiting', 'Ola', 'w-ola', D, 'any', null]);
    // Убираем, чтобы не мешали следующим проверкам очереди.
    await db.admin.query("UPDATE waitlist_entries SET status = 'cancelled' WHERE status = 'waiting'");
  });

  test('очередь: слот предлагается первому, после 30 минут без записи следующему; дважды одному не предлагается', async () => {
    const bookingId = await occupy(D);
    const first = await entryOf((await join()).body.waitlistToken);
    const second = await entryOf((await join()).body.waitlistToken);
    const evening = await entryOf((await join({ partOfDay: 'evening' })).body.waitlistToken);

    assert.deepEqual(await waitlist.process(accountId, noonBefore), [], 'день занят: предлагать нечего');
    await owner.post(`/bookings/${bookingId}/transition`, { to: 'cancelled_by_master' });

    const offered = await waitlist.process(accountId, noonBefore);
    assert.equal(offered.length, 1);
    assert.deepEqual([await offersOf(first), await offersOf(second), await offersOf(evening)], [[at(D, 10).toISOString()], [], []]);
    assert.deepEqual(await waitlist.process(accountId, new Date(noonBefore.getTime() + 10 * MIN)), [], 'пока предложение действует, слот другим не предлагается');

    const later = new Date(noonBefore.getTime() + 31 * MIN);
    assert.equal((await waitlist.process(accountId, later)).length, 1);
    assert.deepEqual([(await offersOf(first)).length, await offersOf(second)], [1, [at(D, 10).toISOString()]]);
    assert.deepEqual(await offersOf(evening), [], 'утренний слот вечерней очереди не предлагается');
    assert.deepEqual(await waitlist.process(accountId, new Date(later.getTime() + 31 * MIN)), [], 'всем, кому подходит, уже предлагали');

    // Мастер видит очередь по порядку и действующее предложение; staff другого специалиста её не видит.
    const list = (await owner.get('/waitlist')).body as Array<{ id: string; offer: unknown }>;
    assert.deepEqual(list.map((e) => e.id), [first, second, evening]);
    assert.deepEqual((await ewa.get('/waitlist')).body, []);
    assert.equal((await ewa.delete(`/waitlist/${evening}`)).status, 404);
    assert.equal((await owner.delete(`/waitlist/${evening}`)).status, 204);
    assert.equal(await status(evening), 'cancelled');
  });

  test('запись к специалисту на день из периода закрывает ожидание', async () => {
    const waiting = (await db.admin.query("SELECT id, client_id FROM waitlist_entries WHERE status = 'waiting' ORDER BY created_at LIMIT 1")).rows[0];
    await bookings.create({
      accountId,
      staffId: olaStaff,
      clientId: waiting.client_id,
      serviceId: service.id,
      variantId: service.variants[0]!.id,
      startsAt: at(D, 10),
      requiresApproval: false,
      actor: 'client',
    });
    assert.equal(await status(waiting.id), 'booked');
    assert.ok(!(await owner.get('/waitlist')).body.some((e: { id: string }) => e.id === waiting.id));
  });

  test('ночью предложения не уходят; прошедший период истекает; клиент из blacklist остаётся без предложений', async () => {
    await db.admin.query("UPDATE waitlist_entries SET status = 'cancelled' WHERE status = 'waiting'");
    const D2 = addDays(D, 1);
    const night = await entryOf((await join({ dateFrom: D2, dateTo: D2 })).body.waitlistToken);
    assert.deepEqual(await waitlist.process(accountId, at(D, 22)), [], '22:00 по Варшаве');
    assert.deepEqual(await waitlist.process(accountId, at(D, 6)), [], '06:00');

    // Blacklist по номеру клиента: предложений нет, хотя слот свободен.
    const hash = (await db.admin.query('SELECT c.phone_hash FROM waitlist_entries e JOIN clients c ON c.id = e.client_id WHERE e.id = $1', [night])).rows[0].phone_hash;
    await db.admin.query("INSERT INTO blacklist_entries (account_id, phone_hash, expires_at) VALUES ($1, $2, now() + interval '1 day')", [accountId, hash]);
    assert.deepEqual(await waitlist.process(accountId, at(D, 12)), []);
    await db.admin.query('DELETE FROM blacklist_entries WHERE phone_hash = $1', [hash]);
    assert.equal((await waitlist.process(accountId, at(D, 12))).length, 1);

    await waitlist.process(accountId, at(addDays(D2, 1), 12));
    assert.equal(await status(night), 'expired');
  });

  test('ссылка клиента: выход из очереди, токен записи не подходит, подделка 404', async () => {
    const token = (await join({ dateFrom: addDays(D, 3), dateTo: addDays(D, 5) })).body.waitlistToken as string;
    const entryId = await entryOf(token);
    assert.equal((await anon.post(`/public/waitlist/${token}/cancel`)).status, 204);
    assert.equal((await anon.post(`/public/waitlist/${token}/cancel`)).status, 204, 'повтор ничего не меняет');
    assert.equal((await anon.get(`/public/waitlist/${token}`)).body.status, 'cancelled');
    assert.equal(await status(entryId), 'cancelled');
    const bookingToken = tokens.issue(accountId, entryId);
    assert.equal((await anon.get(`/public/waitlist/${bookingToken}`)).status, 404, 'токен записи не открывает очередь');
    assert.equal(tokens.verify(token), null, 'токен очереди не открывает запись');
    assert.equal((await anon.get(`/public/waitlist/${token.slice(0, -2)}AA`)).status, 404);
  });

  test('уведомления: подтверждение со ссылкой выхода, предложение со ссылкой на запись; истёкшее не отправляется', async () => {
    const sms = new CapturingChannel('sms');
    const dispatcher = new NotificationDispatcher(db.app, new FieldCipher(new EnvKeyProvider(TEST_CONFIG.fieldMasterKey)), tokens, [sms], TEST_CONFIG.publicUrl);
    await db.admin.query("UPDATE waitlist_entries SET status = 'cancelled' WHERE status = 'waiting'");
    const D3 = addDays(D, 2);
    const entryId = await entryOf((await join({ dateFrom: D3, dateTo: D3 })).body.waitlistToken);

    await dispatcher.dispatch({ type: 'waitlist.joined', accountId, entryId });
    assert.match(sms.sent[0]!.text, new RegExp(`${TEST_CONFIG.publicUrl}/w/v1\\.`));

    // «Сейчас» задачи: полдень накануне D3, это в будущем, поэтому предложение действует и для диспетчера.
    const [offerId] = await waitlist.process(accountId, at(addDays(D3, -1), 12));
    assert.ok(offerId);
    await dispatcher.dispatch({ type: 'waitlist.offer', accountId, offerId: offerId! });
    const text = sms.sent[1]!.text;
    assert.match(text, new RegExp(`/w-ola\\?service=${service.id}&variant=${service.variants[0]!.id}&date=${D3}&lang=pl`));
    assert.match(text, /30 minut/);

    await db.admin.query("UPDATE waitlist_offers SET expires_at = now() - interval '1 minute', created_at = now() - interval '40 minutes' WHERE id = $1", [offerId]);
    await db.admin.query('DELETE FROM notification_log WHERE dedupe_key = $1', [`waitlist.offer:${offerId}`]);
    await dispatcher.dispatch({ type: 'waitlist.offer', accountId, offerId: offerId! });
    assert.equal(sms.sent.length, 2, 'истёкшее предложение не отправляется');
  });

  test('функция фоновой задачи отдаёт только id Account и недоступна PUBLIC', async () => {
    const rows = (await db.admin.query('SELECT * FROM jobs_accounts_with_waitlist() AS id')).rows;
    assert.ok(rows.every((r) => Object.keys(r).length === 1));
    const grants = await db.admin.query(
      "SELECT grantee FROM information_schema.routine_privileges WHERE routine_name = 'jobs_accounts_with_waitlist' AND privilege_type = 'EXECUTE'",
    );
    assert.ok(!grants.rows.some((g) => g.grantee === 'PUBLIC'));
  });
});
