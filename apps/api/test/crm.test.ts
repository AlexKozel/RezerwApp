import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { addDays, localDate, zonedToUtc } from '../src/availability/zoned-time';
import { Client, TEST_OTP, createTestApp, type TestApp, inviteUser } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const WAW = 'Europe/Warsaw';
const PHONE_A = '+48500100200';
const PHONE_B = '+48600200300';

describe('CRM (D-050): карточка, заметки, blacklist, экспорт, анонимизация, аудит', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let staff: Client;
  let assistant: Client;
  let anon: Client;
  let service: { id: string; variants: Array<{ id: string }> };
  let clientA: string;
  let clientB: string;
  const day = addDays(localDate(new Date(), WAW), 7);
  const at = (h: number) => zonedToUtc(day, h * 60, WAW)!.toISOString();

  const login = async (email: string) => {
    const c = new Client(t.url);
    assert.equal((await c.post('/auth/login', { email, password: PASSWORD })).status, 200);
    return c;
  };
  const book = (slug: string, phone: string, hour: number, extra: Record<string, unknown> = {}) =>
    anon.post(`/public/staff/${slug}/bookings`, {
      serviceId: service.id,
      variantId: service.variants[0]!.id,
      startsAt: at(hour),
      name: 'Klient',
      phone,
      otpCode: TEST_OTP,
      acceptTerms: true,
      acceptPrivacy: true,
      ...extra,
    });

  before(async () => {
    db = await createTestDb('crm');
    t = await createTestApp(db);
    anon = new Client(t.url);
    await db.admin.query(
      `INSERT INTO consent_documents (type, language, version, body) VALUES
         ('terms', 'pl', '1', 'R'), ('privacy', 'pl', '1', 'P'), ('health', 'pl', '1', 'H')`,
    );
    await createMaster(db.app, { accountName: 'Salon', email: 'owner@crm.pl', password: PASSWORD });
    owner = await login('owner@crm.pl');
    const s1 = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'crm-ola' })).body.id;
    const s2 = (await owner.post('/staff', { displayName: 'Ewa', publicSlug: 'crm-ewa' })).body.id;
    await inviteUser(t.url, owner, { email: 'ola@crm.pl', role: 'staff', staffId: s1 }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'desk@crm.pl', role: 'assistant' }, PASSWORD);
    staff = await login('ola@crm.pl');
    assistant = await login('desk@crm.pl');

    service = (await owner.post('/services', { name: { pl: 'Masaż' }, requiresManualConfirm: false, variants: [{ durationMin: 60, price: 200 }] })).body.service;
    const week = { intervals: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, start: '08:00', end: '20:00' })) };
    for (const id of [s1, s2]) {
      await owner.put(`/staff/${id}/services/${service.id}`);
      await owner.put(`/staff/${id}/working-hours`, week);
    }
    // Клиент A записан к Ole (staff) с согласием на данные о здоровье, клиент B к Ewie.
    assert.equal((await book('crm-ola', PHONE_A, 9, { name: 'Anna Nowak', acceptHealth: true })).status, 201);
    assert.equal((await book('crm-ewa', PHONE_B, 9, { name: 'Bartek' })).status, 201);
    const ids = await db.admin.query('SELECT id, name FROM clients ORDER BY name');
    clientA = ids.rows.find((r) => r.name === 'Anna Nowak').id;
    clientB = ids.rows.find((r) => r.name === 'Bartek').id;
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('поиск: по телефону точно (через HMAC), по имени подстрокой; шаблоны LIKE экранируются', async () => {
    assert.equal((await owner.get('/clients')).body.length, 2);
    assert.deepEqual((await owner.get(`/clients?search=${encodeURIComponent('500 100 200')}`)).body.map((c: { id: string }) => c.id), [clientA]);
    assert.deepEqual((await owner.get('/clients?search=NOWA')).body.map((c: { id: string }) => c.id), [clientA]);
    assert.deepEqual((await owner.get(`/clients?search=${encodeURIComponent('%')}`)).body, []);
  });

  test('staff видит только своих клиентов; чужой клиент для него не существует', async () => {
    assert.deepEqual((await staff.get('/clients')).body.map((c: { id: string }) => c.id), [clientA]);
    assert.deepEqual((await staff.get(`/clients/${clientB}`)).body, { error: 'NOT_FOUND' });
    assert.equal((await staff.post(`/clients/${clientB}/notes`, { body: 'x' })).status, 404);
  });

  test('карточка: телефон расшифрован, согласия и история; чтение записано в аудит', async () => {
    const card = (await owner.get(`/clients/${clientA}`)).body;
    assert.equal(card.phone, PHONE_A);
    assert.equal(card.bookings.length, 1);
    assert.deepEqual(card.consents.map((c: { type: string }) => c.type).sort(), ['health', 'privacy', 'terms']);
    assert.equal(card.blacklisted, null);
    const audit = await db.admin.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'client.read' AND object_id = $1", [clientA]);
    assert.ok(audit.rows[0].n >= 1);
  });

  test('assistant: карточка да; заметки, blacklist, экспорт, удаление, аудит нет', async () => {
    assert.equal((await assistant.get(`/clients/${clientA}`)).status, 200);
    assert.equal((await assistant.get(`/clients/${clientA}/notes`)).status, 403);
    assert.equal((await assistant.post(`/clients/${clientA}/blacklist`)).status, 403);
    assert.equal((await assistant.get('/clients/export')).status, 403);
    assert.equal((await assistant.delete(`/clients/${clientA}`)).status, 403);
    assert.equal((await assistant.get('/audit')).status, 403);
    assert.equal((await staff.get('/audit')).status, 403);
  });

  test('заметки шифруются; о здоровье только при согласии клиента (D-025, L-23)', async () => {
    assert.equal((await staff.post(`/clients/${clientA}/notes`, { body: 'Lubi kawę z mlekiem' })).status, 201);
    assert.equal((await staff.post(`/clients/${clientA}/notes`, { body: 'Alergia na lateks', sensitivity: 'health' })).status, 201);
    const refused = await owner.post(`/clients/${clientB}/notes`, { body: 'Alergia', sensitivity: 'health' });
    assert.deepEqual([refused.status, refused.body], [409, { error: 'HEALTH_CONSENT_REQUIRED' }]);

    const notes = (await owner.get(`/clients/${clientA}/notes`)).body;
    assert.deepEqual(notes.map((n: { body: string }) => n.body).sort(), ['Alergia na lateks', 'Lubi kawę z mlekiem']);
    const raw = await db.admin.query('SELECT body_encrypted FROM client_notes WHERE client_id = $1', [clientA]);
    for (const r of raw.rows) assert.ok(!r.body_encrypted.toString('utf8').includes('lateks'));

    const kawa = notes.find((n: { body: string }) => n.body.startsWith('Lubi'));
    assert.equal((await staff.delete(`/clients/${clientA}/notes/${kawa.id}`)).status, 204);
    assert.equal((await owner.get(`/clients/${clientA}/notes`)).body.length, 1);
  });

  test('клиент вручную: дубль телефона даёт id существующей карточки; правка карточки', async () => {
    const dup = await owner.post('/clients', { name: 'Ktoś', phone: '500-100-200' });
    assert.deepEqual([dup.status, dup.body], [409, { error: 'CLIENT_EXISTS', clientId: clientA }]);
    const created = await owner.post('/clients', { name: 'Celina', phone: '700 800 900', language: 'uk', email: 'c@example.pl' });
    assert.equal(created.status, 201);
    assert.equal((await owner.patch(`/clients/${created.body.id}`, { name: 'Celina K.', email: null })).status, 204);
    const card = (await owner.get(`/clients/${created.body.id}`)).body;
    assert.deepEqual([card.name, card.email, card.language, card.phone], ['Celina K.', null, 'uk', '+48700800900']);
  });

  test('blacklist: запись с номера блокируется нейтрально, снятие возвращает доступ', async () => {
    const added = await owner.post(`/clients/${clientB}/blacklist`, { reason: 'no-show x3', days: 30 });
    assert.equal(added.status, 201);
    assert.equal((await owner.get(`/clients/${clientB}`)).body.blacklisted.reason, 'no-show x3');
    assert.deepEqual((await book('crm-ewa', PHONE_B, 12)).body, { error: 'NO_FREE_SLOTS' });
    assert.equal((await owner.delete(`/clients/${clientB}/blacklist`)).status, 204);
    assert.equal((await book('crm-ewa', PHONE_B, 12)).status, 201);
  });

  test('экспорт JSON и CSV (D-022): телефоны, записи, согласия; CSV защищён от формул', async () => {
    await owner.post('/clients', { name: '=HYPERLINK("http://evil")', phone: '711 111 111' });
    const json = (await owner.get('/clients/export')).body;
    assert.ok(json.clients.some((c: { phone: string }) => c.phone === PHONE_A));
    assert.ok(json.bookings.length >= 3);
    assert.ok(json.consents.length >= 5);

    const csv = await owner.get('/clients/export?format=csv');
    assert.match(csv.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(csv.headers.get('content-disposition') ?? '', /attachment; filename="clients-\d{4}-\d{2}-\d{2}\.csv"/);
    assert.ok(csv.body.startsWith('id,name,phone,email,language,birthday,createdAt,anonymizedAt\r\n'));
    assert.deepEqual([...(await owner.bytes('/clients/export?format=csv')).subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM для Excel');
    assert.ok(csv.body.includes(PHONE_A));
    assert.ok(csv.body.includes(`"'=HYPERLINK(""http://evil"")"`));
  });

  test('анонимизация по запросу клиента (RODO): данные стёрты, история осталась, номер больше не находит карточку', async () => {
    await owner.post(`/clients/${clientB}/blacklist`, {});
    assert.equal((await owner.delete(`/clients/${clientB}`)).status, 204);
    const card = (await owner.get(`/clients/${clientB}`)).body;
    assert.deepEqual([card.name, card.phone, card.email, card.anonymized, card.blacklisted], ['—', null, null, true, null]);
    assert.equal(card.bookings.length, 2, 'записи сохранены для учёта мастера');
    assert.equal(card.consents.length, 4, 'согласия обеих записей сохранены как доказательство');
    assert.deepEqual((await owner.get(`/clients?search=${encodeURIComponent(PHONE_B)}`)).body, []);
    assert.equal((await owner.patch(`/clients/${clientB}`, { name: 'X' })).status, 409);
    assert.equal((await book('crm-ewa', PHONE_B, 15)).status, 201, 'тот же номер создаёт новую карточку');
    assert.equal((await owner.get(`/clients?search=${encodeURIComponent(PHONE_B)}`)).body.length, 1);
  });

  test('журнал аудита у owner: кто и что читал и менял', async () => {
    const log = (await owner.get('/audit')).body as Array<{ action: string; actorEmail: string }>;
    const actions = new Set(log.map((e) => e.action));
    for (const a of ['client.read', 'notes.read', 'notes.write', 'notes.delete', 'blacklist.add', 'blacklist.remove', 'clients.export', 'client.anonymize']) {
      assert.ok(actions.has(a), a);
    }
    assert.ok(log.some((e) => e.action === 'notes.write' && e.actorEmail === 'ola@crm.pl'));
    await assert.rejects(db.app.withAccount((await owner.get('/auth/me')).body.accountId, (c) => c.query('DELETE FROM audit_log')), /permission denied/);
  });
});
