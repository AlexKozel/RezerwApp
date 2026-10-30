import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { addDays, localDate } from '../src/availability/zoned-time';
import { ExpensesService } from '../src/expenses/expenses.service';
import { Client, createTestApp, inviteUser, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const DAY = 86_400_000;
const WAW = 'Europe/Warsaw';

describe('расходы и «осталось себе» (D-071)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let ola: Client;
  let ewa: Client;
  let desk: Client;
  let accountId: string;
  let olaStaff: string;
  let ewaStaff: string;
  let service: { id: string; variants: Array<{ id: string }> };
  const today = localDate(new Date(), WAW);

  const login = async (email: string) => {
    const c = new Client(t.url);
    assert.equal((await c.post('/auth/login', { email, password: PASSWORD })).status, 200, email);
    return c;
  };
  /** Завершённый визит позавчера у специалиста staffId. */
  let seq = 0;
  const completed = async (staffId: string) => {
    seq += 1;
    const r = await owner.post('/bookings', {
      staffId,
      serviceId: service.id,
      variantId: service.variants[0]!.id,
      startsAt: new Date(Math.floor((Date.now() - 2 * DAY) / 3_600_000) * 3_600_000 - seq * 2 * 3_600_000).toISOString(),
      client: { name: `K${seq}`, phone: `+4855000${String(seq).padStart(4, '0')}` },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await owner.post(`/bookings/${r.body.id}/transition`, { to: 'completed' });
    return r.body.id as string;
  };
  const summary = async (who: Client) => {
    const from = new Date(Date.now() - 10 * DAY).toISOString();
    const to = new Date(Date.now() + DAY).toISOString();
    return (await who.get(`/analytics/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).body;
  };

  before(async () => {
    db = await createTestDb('expenses');
    t = await createTestApp(db);
    ({ accountId } = await createMaster(db.app, { accountName: 'Studio', email: 'owner@e.pl', password: PASSWORD }));
    owner = await login('owner@e.pl');
    olaStaff = (await owner.post('/staff', { displayName: 'Ola', publicSlug: 'e-ola' })).body.id;
    ewaStaff = (await owner.post('/staff', { displayName: 'Ewa', publicSlug: 'e-ewa' })).body.id;
    await inviteUser(t.url, owner, { email: 'ola@e.pl', role: 'staff', staffId: olaStaff }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'ewa@e.pl', role: 'staff', staffId: ewaStaff }, PASSWORD);
    await inviteUser(t.url, owner, { email: 'desk@e.pl', role: 'assistant' }, PASSWORD);
    ola = await login('ola@e.pl');
    ewa = await login('ewa@e.pl');
    desk = await login('desk@e.pl');
    // Себестоимость материалов 30 zł на визит.
    service = (await owner.post('/services', { name: { pl: 'Manicure' }, requiresManualConfirm: false, costPrice: 30, variants: [{ durationMin: 60, price: 150 }] })).body.service;
    for (const s of [olaStaff, ewaStaff]) await owner.put(`/staff/${s}/services/${service.id}`);
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('журнал только у owner; проверка суммы, категории и дня месяца', async () => {
    for (const c of [ola, desk]) assert.equal((await c.get(`/expenses?from=${today}&to=${addDays(today, 1)}`)).status, 403);
    assert.equal((await ola.post('/expenses', { spentOn: today, category: 'rent', amount: 100 })).status, 403);
    assert.equal((await owner.post('/expenses', { spentOn: today, category: 'yacht', amount: 100 })).status, 400);
    assert.equal((await owner.post('/expenses', { spentOn: today, category: 'materials', amount: 0 })).status, 400);
    assert.equal((await owner.post('/expenses', { spentOn: today, category: 'materials', amount: '12.345' })).status, 400);
    assert.equal((await owner.post('/expenses/recurring', { category: 'rent', amount: 1000, dayOfMonth: 29, startsOn: today })).status, 400, 'до 28 числа');
  });

  test('повторяющийся расход: начисления по месяцам с начала правила; остановка оставляет текущий месяц', async () => {
    const svc = new ExpensesService(db.app);
    const { id } = await svc.addRecurring(accountId, { category: 'rent', amount: 1200, note: 'Lokal', dayOfMonth: 5, startsOn: '2030-01-10' });
    const q = await svc.list(accountId, '2030-01-01', '2030-05-01');
    assert.deepEqual(q.charges.map((c) => c.chargedOn), ['2030-04-05', '2030-03-05', '2030-02-05'], 'январь: 5-е раньше начала правила');
    assert.equal(q.totals.byCategory.rent, 3600);

    await svc.stopRecurring(accountId, id, new Date('2030-03-15T12:00:00Z'));
    const after = await svc.list(accountId, '2030-01-01', '2030-05-01');
    assert.deepEqual(after.charges.map((c) => c.chargedOn), ['2030-03-05', '2030-02-05'], 'март ещё начислен, апреля нет');
    assert.equal(after.recurring.find((r) => r.id === id)?.endsOn, '2030-03-31');

    const future = await svc.addRecurring(accountId, { category: 'software', amount: 50, note: null, dayOfMonth: 1, startsOn: '2030-06-01' });
    await svc.stopRecurring(accountId, future.id, new Date('2030-03-15T12:00:00Z'));
    assert.equal((await db.admin.query('SELECT 1 FROM recurring_expenses WHERE id = $1', [future.id])).rowCount, 0, 'не начавшееся правило удаляется');
  });

  test('«Результаты» owner: выручка − себестоимость − расходы; staff без расходов салона', async () => {
    await completed(olaStaff);
    await completed(ewaStaff);
    assert.equal((await owner.post('/expenses', { spentOn: today, category: 'materials', amount: '45.50', note: 'Lakiery' })).status, 201);
    await owner.post('/expenses/recurring', { category: 'rent', amount: 500, dayOfMonth: 1, startsOn: addDays(today, -40) });

    const s = await summary(owner);
    const rentCharges = (await owner.get(`/expenses?from=${localDate(new Date(Date.now() - 10 * DAY), WAW)}&to=${localDate(new Date(Date.now() + DAY), WAW)}`)).body.totals.byCategory.rent ?? 0;
    assert.equal(s.revenue, 300);
    assert.equal(s.expenses.byCategory.materials, 45.5);
    assert.equal(s.expenses.total, 45.5 + rentCharges);
    assert.equal(s.profit, 300 - 60 - s.expenses.total, 'две услуги по 30 себестоимости');

    const staffView = await summary(ola);
    assert.deepEqual([staffView.revenue, staffView.expenses, staffView.profit], [150, null, null]);
  });

  test('разовые затраты на визит: только при включённой опции; staff своим визитам; входят в себестоимость', async () => {
    const mine = await completed(olaStaff);
    assert.deepEqual((await ola.post(`/bookings/${mine}/extra-cost`, { amount: 20 })).body, { error: 'VISIT_COSTS_OFF' });
    assert.equal((await ola.get('/auth/me')).body.trackVisitCosts, false);
    assert.equal((await ola.patch('/account/finance', { trackVisitCosts: true })).status, 403);
    assert.deepEqual((await owner.patch('/account/finance', { trackVisitCosts: true })).body, { trackVisitCosts: true });
    assert.equal((await ola.get('/auth/me')).body.trackVisitCosts, true);

    assert.equal((await ewa.post(`/bookings/${mine}/extra-cost`, { amount: 20 })).status, 403, 'чужой визит');
    assert.equal((await desk.post(`/bookings/${mine}/extra-cost`, { amount: 20 })).status, 403);
    assert.equal((await ola.post(`/bookings/${mine}/extra-cost`, { amount: '20.50' })).status, 204);
    const before = await summary(owner);
    assert.equal(before.visitCosts, 20.5);
    assert.equal(before.services[0].cost, 3 * 30 + 20.5);
    assert.equal((await ola.post(`/bookings/${mine}/extra-cost`, { amount: null })).status, 204);
    assert.equal((await summary(owner)).visitCosts, 0);
  });

  test('удаление расхода и изоляция Account (RLS)', async () => {
    const list = (await owner.get(`/expenses?from=${today}&to=${addDays(today, 1)}`)).body;
    const id = list.items[0].id;
    const other = await createMaster(db.app, { accountName: 'Obcy', email: 'obcy@e.pl', password: PASSWORD });
    assert.equal((await db.app.withAccount(other.accountId, (c) => c.query('SELECT 1 FROM expenses'))).rowCount, 0);
    assert.equal((await owner.delete(`/expenses/${id}`)).status, 204);
    assert.equal((await owner.delete(`/expenses/${id}`)).status, 404);
  });
});
