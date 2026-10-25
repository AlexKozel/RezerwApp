import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { BookingsService } from '../src/bookings/bookings.service';
import { ClientsService } from '../src/clients/clients.service';
import { CrmService } from '../src/clients/crm.service';
import { FieldCipher } from '../src/crypto/field-cipher';
import { EnvKeyProvider } from '../src/crypto/key-provider';
import { PhoneHasher } from '../src/crypto/phone-hash';
import { MaintenanceJobs } from '../src/jobs/maintenance';
import { Client, RecordingNotifier, TEST_CONFIG, createTestApp, inviteUser, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const HOUR = 3_600_000;

/** Пояс Etc/GMT, в котором сейчас примерно localHour часов (Etc/GMT-3 = UTC+3), и местная дата в нём. */
function zoneAt(localHour: number): { zone: string; today: string } {
  let k = localHour - new Date().getUTCHours();
  if (k < -12) k += 24;
  if (k > 14) k -= 24;
  return { zone: k === 0 ? 'Etc/GMT' : `Etc/GMT${k > 0 ? '-' : '+'}${Math.abs(k)}`, today: new Date(Date.now() + k * HOUR).toISOString().slice(0, 10) };
}

describe('клиенты вручную и дни рождения (D-065)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let ola: Client;
  let ewa: Client;
  let desk: Client;
  let accountId: string;

  const login = async (email: string) => {
    const c = new Client(t.url);
    assert.equal((await c.post('/auth/login', { email, password: PASSWORD })).status, 200, email);
    return c;
  };
  const ids = (list: Array<{ id: string }>) => list.map((c) => c.id).sort();

  before(async () => {
    db = await createTestDb('clients_manual');
    t = await createTestApp(db);
    ({ accountId } = await createMaster(db.app, { accountName: 'Salon Róża', email: 'owner@roza.pl', password: PASSWORD }));
    owner = await login('owner@roza.pl');
    const olaStaff = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'roza-ola' })).body.id;
    const ewaStaff = (await owner.post('/staff', { displayName: 'Ewa', publicSlug: 'roza-ewa' })).body.id;
    await inviteUser(t.url, owner, { email: 'ola@roza.pl', role: 'staff', staffId: olaStaff }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'ewa@roza.pl', role: 'staff', staffId: ewaStaff }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'desk@roza.pl', role: 'assistant' }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'nobody@roza.pl', role: 'staff' }, PASSWORD);
    ola = await login('ola@roza.pl');
    ewa = await login('ewa@roza.pl');
    desk = await login('desk@roza.pl');
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('клиент, внесённый сотрудником, виден ему без записей; другим сотрудникам нет; владельцу и ассистенту да', async () => {
    const created = await ola.post('/clients', { name: 'Zofia Nowak', phone: '501 111 222', birthday: '03-12' });
    assert.deepEqual([created.status, created.body.linked], [201, false]);
    const id = created.body.id as string;
    assert.deepEqual(ids((await ola.get('/clients')).body), [id]);
    assert.equal((await ola.get(`/clients/${id}`)).body.birthday, '03-12');
    assert.deepEqual((await ewa.get('/clients')).body, []);
    assert.equal((await ewa.get(`/clients/${id}`)).status, 404, 'чужой клиент для сотрудника не существует');
    assert.deepEqual(ids((await owner.get('/clients')).body), [id]);
    assert.equal((await desk.get(`/clients/${id}`)).status, 200);
  });

  test('номер клиента другого мастера: привязка ко второму, карточка не меняется, привязка в аудите', async () => {
    const id = (await owner.get('/clients?search=501111222')).body[0].id;
    const linked = await ewa.post('/clients', { name: 'Zosia', phone: '+48 501-111-222', birthday: '01-01', email: 'z@example.pl' });
    assert.deepEqual([linked.status, linked.body], [201, { id, linked: true }]);
    const card = (await ewa.get(`/clients/${id}`)).body;
    assert.deepEqual([card.name, card.birthday, card.email], ['Zofia Nowak', '03-12', null], 'чужие данные не перезаписаны');
    // Повтор: клиент уже свой, значит, это дубль.
    assert.deepEqual([(await ewa.post('/clients', { name: 'Zosia', phone: '501111222' })).status], [409]);
    // Владелец видит всех: существующий номер всегда CLIENT_EXISTS с id.
    const dup = await owner.post('/clients', { name: 'X', phone: '501111222' });
    assert.deepEqual([dup.status, dup.body], [409, { error: 'CLIENT_EXISTS', clientId: id }]);
    const log = (await owner.get('/audit')).body as Array<{ action: string; actorEmail: string; objectId: string }>;
    assert.ok(log.some((e) => e.action === 'client.link' && e.actorEmail === 'ewa@roza.pl' && e.objectId === id));
  });

  test('сотрудник без профиля специалиста клиента не создаёт', async () => {
    const nobody = await login('nobody@roza.pl');
    assert.equal((await nobody.post('/clients', { name: 'Nikt', phone: '509 999 999' })).status, 403);
  });

  test('день рождения: только день и месяц, проверка даты, правка и стирание, экспорт, анонимизация', async () => {
    for (const bad of ['02-30', '04-31', '13-01', '1990-03-12', '3-12']) {
      assert.equal((await owner.post('/clients', { name: 'Bad', phone: '502 000 001', birthday: bad })).status, 400, bad);
    }
    const id = (await owner.post('/clients', { name: 'Leap', phone: '502 000 002', birthday: '02-29' })).body.id;
    assert.equal((await owner.get(`/clients/${id}`)).body.birthday, '02-29');
    assert.equal((await owner.patch(`/clients/${id}`, { birthday: '12-31' })).status, 204);
    assert.equal((await owner.get(`/clients/${id}`)).body.birthday, '12-31');
    assert.equal((await owner.patch(`/clients/${id}`, { name: 'Leap K.' })).status, 204);
    assert.equal((await owner.get(`/clients/${id}`)).body.birthday, '12-31', 'правка имени не стирает ДР');
    assert.equal((await owner.patch(`/clients/${id}`, { birthday: null })).status, 204);
    assert.equal((await owner.get(`/clients/${id}`)).body.birthday, null);

    await owner.patch(`/clients/${id}`, { birthday: '07-04' });
    const exported = (await owner.get('/clients/export')).body.clients.find((c: { id: string }) => c.id === id);
    assert.equal(exported.birthday, '07-04');
    assert.ok((await owner.get('/clients/export?format=csv')).body.startsWith('id,name,phone,email,language,birthday,'));
    assert.equal((await owner.delete(`/clients/${id}`)).status, 204);
    const row = (await db.admin.query('SELECT birth_month, birth_day FROM clients WHERE id = $1', [id])).rows[0];
    assert.deepEqual(row, { birth_month: null, birth_day: null }, 'анонимизация стирает ДР');
  });

  test('ограничение БД: невозможная дата и половина даты не сохраняются даже в обход API', async () => {
    const id = (await owner.get('/clients?search=501111222')).body[0].id;
    await db.app.withAccount(accountId, async (c) => {
      await assert.rejects(c.query('UPDATE clients SET birth_month = 4, birth_day = 31 WHERE id = $1', [id]), /clients_birthday_valid/);
    });
    await db.app.withAccount(accountId, async (c) => {
      await assert.rejects(c.query('UPDATE clients SET birth_month = 4, birth_day = NULL WHERE id = $1', [id]), /clients_birthday_valid/);
    });
  });

  test('именинники: период, только свои клиенты, 29 февраля в невисокосный год 28-го', async () => {
    const mine = (await ola.post('/clients', { name: 'Ola-1', phone: '503 000 001', birthday: '05-10' })).body.id;
    const other = (await ewa.post('/clients', { name: 'Ewa-1', phone: '503 000 002', birthday: '05-11' })).body.id;
    const leap = (await owner.post('/clients', { name: 'Leap-2', phone: '503 000 003', birthday: '02-29' })).body.id;

    assert.deepEqual((await ola.get('/clients/birthdays?from=2027-05-09&days=5')).body, [{ date: '2027-05-10', id: mine, name: 'Ola-1' }]);
    assert.deepEqual(
      (await owner.get('/clients/birthdays?from=2027-05-09&days=5')).body.map((b: { id: string }) => b.id),
      [mine, other],
    );
    assert.deepEqual((await owner.get('/clients/birthdays?from=2027-02-28')).body.map((b: { id: string }) => b.id), [leap]);
    assert.deepEqual((await owner.get('/clients/birthdays?from=2028-02-28')).body, [], 'високосный год: 28-го нет');
    assert.deepEqual((await owner.get('/clients/birthdays?from=2028-02-29')).body.map((b: { id: string }) => b.id), [leap]);
    assert.equal((await owner.get('/clients/birthdays?from=2027-05-09&days=40')).status, 400);
    assert.equal((await owner.get('/clients/birthdays?from=2027-02-30')).status, 400);
  });

  test('связи клиент-специалист изолированы по Account (RLS)', async () => {
    const other = await createMaster(db.app, { accountName: 'Obcy', email: 'obcy@x.pl', password: PASSWORD });
    const rows = await db.app.withAccount(other.accountId, (c) => c.query('SELECT * FROM client_staff'));
    assert.equal(rows.rowCount, 0);
    const link = (await db.admin.query('SELECT client_id, staff_id FROM client_staff LIMIT 1')).rows[0];
    await db.app.withAccount(other.accountId, async (c) => {
      await assert.rejects(
        c.query('INSERT INTO client_staff (account_id, client_id, staff_id) VALUES ($1, $2, $3)', [accountId, link.client_id, link.staff_id]),
        /row-level security/,
      );
    });
  });

  test('утреннее напоминание: с 09:00 по поясу Account, только при именинниках, один раз в день', async () => {
    const hasher = new PhoneHasher(TEST_CONFIG.phoneHashPepper);
    const cipher = new FieldCipher(new EnvKeyProvider(TEST_CONFIG.fieldMasterKey));
    const notifier = new RecordingNotifier();
    const jobs = new MaintenanceJobs(db.app, new BookingsService(db.app), new CrmService(db.app, new ClientsService(hasher, cipher), hasher, cipher), notifier);
    const due = async () => (await db.admin.query('SELECT account_id, day FROM jobs_accounts_with_birthdays()')).rows;

    const noon = zoneAt(12);
    await db.admin.query('UPDATE accounts SET timezone = $2 WHERE id = $1', [accountId, noon.zone]);
    assert.deepEqual(await due(), [], 'именинников сегодня нет');
    const today = noon.today.slice(5);
    await owner.post('/clients', { name: 'Solenizantka', phone: '504 000 001', birthday: today });
    assert.deepEqual(await due(), [{ account_id: accountId, day: noon.today }]);

    await jobs.run();
    assert.deepEqual(
      notifier.events.filter((e) => e.type === 'account.birthdays'),
      [{ type: 'account.birthdays', accountId, date: noon.today }],
    );
    // Напоминание доставлено (строка в журнале): в этот день больше не предлагается.
    await db.admin.query(
      "INSERT INTO notification_log (account_id, dedupe_key, recipient_kind, recipient_id, template, language, status) VALUES ($1, $2, 'user', gen_random_uuid(), 'notify.master.birthdays', 'pl', 'sandbox')",
      [accountId, `account.birthdays:${noon.today}`],
    );
    assert.deepEqual(await due(), []);

    // До 09:00 по поясу Account напоминание не уходит.
    const early = zoneAt(5);
    await db.admin.query('UPDATE accounts SET timezone = $2 WHERE id = $1', [accountId, early.zone]);
    await db.admin.query('UPDATE clients SET birth_month = $2, birth_day = $3 WHERE name = $1', [
      'Solenizantka',
      Number(early.today.slice(5, 7)),
      Number(early.today.slice(8, 10)),
    ]);
    assert.deepEqual(await due(), []);
    await db.admin.query("UPDATE accounts SET timezone = 'Europe/Warsaw' WHERE id = $1", [accountId]);
  });

  test('роль поиска видит только столбцы дня рождения, не имена и телефоны клиентов', async () => {
    const client = await db.admin.connect();
    try {
      await client.query('SET ROLE rezerwapp_lookup');
      await assert.rejects(client.query('SELECT name FROM clients'), /permission denied/);
      await assert.rejects(client.query('SELECT phone_encrypted FROM clients'), /permission denied/);
      await client.query('SELECT birth_month, birth_day FROM clients');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
    await assert.rejects(db.app.withAccount(accountId, (c) => c.query('SET ROLE rezerwapp_lookup')), /permission denied/, 'приложение не может стать ролью поиска');
  });
});
