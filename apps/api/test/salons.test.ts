import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { BookingsService } from '../src/bookings/bookings.service';
import { InviteTokens } from '../src/locations/locations.service';
import { ManageTokens } from '../src/public/manage-token';
import { Client, TEST_CONFIG, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const HOUR = 3_600_000;

describe('салоны: Location, Independent-мастера, общий календарь, Studio page (D-021, D-022, D-053)', () => {
  let db: TestDb;
  let t: TestApp;
  let salon: Client;
  let indie: Client;
  let outsider: Client;
  let deskClient: Client;
  let salonAccount: string;
  let indieAccount: string;
  let outsiderAccount: string;
  let locationId: string;
  let indieStaff: string;
  let indieBooking: string;
  let membershipId: string;
  const anon = () => new Client(t.url);

  const login = async (email: string) => {
    const c = new Client(t.url);
    assert.equal((await c.post('/auth/login', { email, password: PASSWORD })).status, 200, email);
    return c;
  };
  const start = new Date(Math.ceil((Date.now() + 3 * 24 * HOUR) / HOUR) * HOUR);

  before(async () => {
    db = await createTestDb('salons');
    t = await createTestApp(db);
    ({ accountId: salonAccount } = await createMaster(db.app, { accountName: 'Salon Róża', email: 'owner@roza.pl', password: PASSWORD }));
    ({ accountId: indieAccount } = await createMaster(db.app, { accountName: 'Kasia Nails', email: 'kasia@nails.pl', password: PASSWORD }));
    ({ accountId: outsiderAccount } = await createMaster(db.app, { accountName: 'Obcy', email: 'obcy@x.pl', password: PASSWORD }));
    salon = await login('owner@roza.pl');
    indie = await login('kasia@nails.pl');
    outsider = await login('obcy@x.pl');
    await salon.post('/users', { email: 'desk@roza.pl', role: 'assistant', password: PASSWORD });
    deskClient = await login('desk@roza.pl');

    // Запись Independent-мастера с клиентом в её собственном Account.
    indieStaff = (await indie.post('/staff', { displayName: 'Kasia', publicSlug: 'kasia-nails' })).body.id;
    const svc = (await indie.post('/services', { name: { pl: 'Manicure' }, variants: [{ durationMin: 90, price: 150 }] })).body.service;
    await indie.put(`/staff/${indieStaff}/services/${svc.id}`);
    const clientId = randomUUID();
    await db.admin.query("INSERT INTO clients (id, account_id, name, phone_encrypted, phone_hash) VALUES ($1, $2, 'Tajna Klientka', '\\x01', '\\x02')", [clientId, indieAccount]);
    indieBooking = (await new BookingsService(db.app).create({
      accountId: indieAccount, staffId: indieStaff, clientId, serviceId: svc.id, variantId: svc.variants[0].id, startsAt: start, requiresApproval: false,
    })).id;
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('Location и Employee: специалист салона привязывается только к своей Location', async () => {
    const loc = await salon.post('/locations', { name: 'Róża Mokotów', address: 'ul. Puławska 1, Warszawa', publicSlug: 'roza-mokotow' });
    assert.equal(loc.status, 201);
    locationId = loc.body.id;
    assert.equal((await salon.post('/locations', { name: 'X', publicSlug: 'roza-mokotow' })).body.error, 'SLUG_TAKEN');
    const employee = (await salon.post('/staff', { displayName: 'Ola', publicSlug: 'roza-ola' })).body.id;
    assert.equal((await salon.put(`/staff/${employee}/location`, { locationId })).status, 204);
    assert.equal((await indie.put(`/staff/${indieStaff}/location`, { locationId })).status, 404, 'чужая Location не видна');
    assert.equal((await deskClient.post('/locations', { name: 'Y', publicSlug: 'roza-y' })).status, 403);
  });

  test('салон не может сам подключить чужой Account (RLS), только мастер по приглашению', async () => {
    await assert.rejects(
      db.app.withAccount(salonAccount, (c) =>
        c.query("INSERT INTO location_memberships (location_id, location_account_id, member_account_id, status) VALUES ($1, $2, $3, 'active')", [
          locationId,
          salonAccount,
          indieAccount,
        ]),
      ),
      /row-level security/,
    );
    assert.equal((await deskClient.post(`/locations/${locationId}/invites`)).status, 403);
  });

  test('приглашение: подделка, чужое назначение, срок, своя Location', async () => {
    const invites = new InviteTokens(TEST_CONFIG.fieldMasterKey);
    const expired = invites.issue(locationId, salonAccount, new Date(Date.now() - 1000));
    assert.deepEqual((await indie.post('/memberships/accept', { token: expired })).body, { error: 'INVITE_INVALID' });
    const manageToken = new ManageTokens(TEST_CONFIG.fieldMasterKey).issue(locationId, salonAccount);
    assert.deepEqual((await indie.post('/memberships/accept', { token: manageToken })).body, { error: 'INVITE_INVALID' }, 'токен другого назначения');
    const { token } = (await salon.post(`/locations/${locationId}/invites`)).body;
    assert.deepEqual((await indie.post('/memberships/accept', { token: `${token.slice(0, -2)}AA` })).body, { error: 'INVITE_INVALID' });
    assert.deepEqual((await salon.post('/memberships/accept', { token })).body, { error: 'OWN_LOCATION' });
  });

  test('мастер принимает приглашение; обе стороны видят подключение с названиями', async () => {
    const { token, expiresAt } = (await salon.post(`/locations/${locationId}/invites`)).body;
    assert.ok(new Date(expiresAt).getTime() > Date.now() + 6 * 24 * HOUR);
    const accepted = await indie.post('/memberships/accept', { token });
    assert.equal(accepted.status, 201);
    assert.deepEqual([accepted.body.side, accepted.body.status, accepted.body.salonName, accepted.body.locationName], ['member', 'active', 'Salon Róża', 'Róża Mokotów']);
    membershipId = accepted.body.id;
    const salonSide = (await salon.get('/memberships')).body;
    assert.deepEqual(salonSide.map((m: { side: string; memberName: string }) => [m.side, m.memberName]), [['salon', 'Kasia Nails']]);
    assert.deepEqual((await outsider.get('/memberships')).body, []);
  });

  test('Studio page: Employee и Independent со ссылками на их страницы записи', async () => {
    const page = (await anon().get('/public/locations/roza-mokotow')).body;
    assert.equal(page.name, 'Róża Mokotów');
    assert.equal(page.address, 'ul. Puławska 1, Warszawa');
    assert.deepEqual(page.staff, [
      { displayName: 'Ola', publicSlug: 'roza-ola', independent: false },
      { displayName: 'Kasia', publicSlug: 'kasia-nails', independent: true },
    ]);
    assert.equal((await anon().get('/public/locations/nie-ma')).status, 404);
  });

  test('общий календарь: у Independent только занятость и минуты для аренды, без клиентов', async () => {
    const from = new Date(start.getTime() - 24 * HOUR).toISOString();
    const to = new Date(start.getTime() + 24 * HOUR).toISOString();
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const cal = (await salon.get(`/locations/${locationId}/calendar?${q}`)).body;
    assert.deepEqual(cal.independents, [
      { memberAccountId: indieAccount, staffId: indieStaff, staffName: 'Kasia', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 90 * 60_000).toISOString() },
    ]);
    assert.deepEqual(cal.busyMinutesByMember, { [indieAccount]: 90 });
    assert.ok(!JSON.stringify(cal).includes('Tajna'), 'имя клиента мастера не попадает к салону');
    assert.equal((await deskClient.get(`/locations/${locationId}/calendar?${q}`)).status, 200, 'assistant салона видит календарь');

    assert.deepEqual((await salon.get('/clients')).body, [], 'клиенты Independent не видны салону');
    assert.equal((await salon.get(`/bookings?${q}`)).body.length, 0);
    await assert.rejects(
      db.app.withAccount(outsiderAccount, (c) => c.query('SELECT * FROM location_busy($1, now(), now() + interval \'1 day\')', [locationId])),
      /location not found/,
    );
  });

  test('уход мастера: пропадает со страницы и из календаря, его данные целы; салон не может вернуть его сам', async () => {
    assert.equal((await indie.post(`/memberships/${membershipId}/end`)).status, 204);
    assert.deepEqual((await anon().get('/public/locations/roza-mokotow')).body.staff.map((s: { publicSlug: string }) => s.publicSlug), ['roza-ola']);
    const from = new Date(start.getTime() - HOUR).toISOString();
    const to = new Date(start.getTime() + 3 * HOUR).toISOString();
    const cal = (await salon.get(`/locations/${locationId}/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).body;
    assert.deepEqual(cal.independents, []);
    const kept = await db.admin.query('SELECT status FROM bookings WHERE id = $1', [indieBooking]);
    assert.equal(kept.rows[0].status, 'confirmed');

    await assert.rejects(
      db.app.withAccount(salonAccount, (c) => c.query("UPDATE location_memberships SET status = 'active' WHERE id = $1", [membershipId])),
      /only the member can activate/,
    );
    await assert.rejects(db.app.withAccount(salonAccount, (c) => c.query('DELETE FROM location_memberships')), /permission denied/);

    const { token } = (await salon.post(`/locations/${locationId}/invites`)).body;
    const again = await indie.post('/memberships/accept', { token });
    assert.deepEqual([again.body.id, again.body.status], [membershipId, 'active'], 'повторное приглашение возвращает то же подключение');
  });

  test('салон тоже может отключить мастера', async () => {
    assert.equal((await salon.post(`/memberships/${membershipId}/end`)).status, 204);
    assert.equal((await salon.post(`/memberships/${membershipId}/end`)).status, 404, 'уже завершено');
    assert.equal((await outsider.post(`/memberships/${membershipId}/end`)).status, 404, 'посторонний не видит подключение');
  });
});
