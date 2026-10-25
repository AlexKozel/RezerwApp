import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { Client, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';

describe('ручная запись мастером и календарь', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let staffUser: Client;
  let s1: string;
  let s2: string;
  let service: { id: string; variants: Array<{ id: string }> };
  const at = (h: number) => new Date(Date.UTC(2031, 0, 6, h)).toISOString();
  const range = `from=${encodeURIComponent('2031-01-06T00:00:00Z')}&to=${encodeURIComponent('2031-01-07T00:00:00Z')}`;

  before(async () => {
    db = await createTestDb('manual');
    t = await createTestApp(db);
    await createMaster(db.app, { accountName: 'Studio', email: 'o@manual.pl', password: PASSWORD });
    owner = new Client(t.url);
    await owner.post('/auth/login', { email: 'o@manual.pl', password: PASSWORD });
    s1 = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'manual-ola' })).body.id;
    s2 = (await owner.post('/staff', { displayName: 'Ewa', publicSlug: 'manual-ewa' })).body.id;
    service = (await owner.post('/services', { name: { pl: 'Pedicure' }, variants: [{ name: { pl: 'Klasyczny' }, durationMin: 60, price: 140 }] })).body.service;
    for (const s of [s1, s2]) await owner.put(`/staff/${s}/services/${service.id}`);
    await owner.post('/users', { email: 'ola@manual.pl', role: 'staff', password: PASSWORD, staffId: s1 });
    staffUser = new Client(t.url);
    await staffUser.post('/auth/login', { email: 'ola@manual.pl', password: PASSWORD });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  const base = (staffId: string, hour: number) => ({ staffId, serviceId: service.id, variantId: service.variants[0]!.id, startsAt: at(hour) });

  test('новый клиент по телефону: запись сразу подтверждена, клиенту уходит подтверждение', async () => {
    const r = await owner.post('/bookings', { ...base(s1, 9), client: { name: 'Zofia', phone: '500 123 456', language: 'pl' } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.status, 'confirmed');
    const event = t.notifications.events.find((e) => e.type === 'booking.created' && 'bookingId' in e && e.bookingId === r.body.id);
    assert.deepEqual(event && 'status' in event ? event.status : null, 'confirmed');
  });

  test('существующий клиент; время вне рабочих часов разрешено, пересечение нет', async () => {
    const clientId = (await owner.get(`/clients?search=${encodeURIComponent('500123456')}`)).body[0].id;
    assert.equal((await owner.post('/bookings', { ...base(s1, 11), clientId })).status, 201);
    const overlap = await owner.post('/bookings', { ...base(s1, 11), clientId });
    assert.deepEqual([overlap.status, overlap.body], [409, { error: 'SLOT_TAKEN' }]);
    assert.equal((await owner.post('/bookings', base(s1, 13))).status, 400, 'нужен clientId или client');
  });

  test('календарь: имя клиента, услуга, специалист, цена; без телефона', async () => {
    const list = (await owner.get(`/bookings?${range}`)).body;
    assert.equal(list.length, 2);
    const [first] = list;
    assert.deepEqual(
      [first.clientName, first.serviceName, first.variantName, first.staffName, first.price, first.payment],
      ['Zofia', { pl: 'Pedicure' }, { pl: 'Klasyczny' }, 'Ola', 140, null],
    );
    assert.ok(!JSON.stringify(list).includes('500123456'));
  });

  test('/auth/me отдаёт данные для интерфейса: Account, пояс, язык, специалист пользователя', async () => {
    const me = (await staffUser.get('/auth/me')).body;
    assert.deepEqual(
      [me.role, me.accountName, me.timeZone, me.locale, me.email, me.staffId],
      ['staff', 'Studio', 'Europe/Warsaw', 'pl', 'ola@manual.pl', s1],
    );
    assert.equal((await owner.get('/auth/me')).body.staffId, null, 'у owner нет своего специалиста');
  });

  test('staff записывает только к себе', async () => {
    const clientId = (await owner.get(`/clients?search=${encodeURIComponent('500123456')}`)).body[0].id;
    assert.equal((await staffUser.post('/bookings', { ...base(s2, 15), clientId })).status, 403);
    assert.equal((await staffUser.post('/bookings', { ...base(s1, 15), clientId })).status, 201);
  });
});
