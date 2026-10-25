import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createMaster } from '../src/auth/auth.service';
import { Client, createTestApp, type TestApp } from './helpers/app';
import { createTestDb, type TestDb } from './helpers/test-db';

const PASSWORD = 'very secret 123';
const TEMP = 'temporary 12345';
const range = `from=${encodeURIComponent('2030-01-01T00:00:00Z')}&to=${encodeURIComponent('2030-01-02T00:00:00Z')}`;

describe('приглашение сотрудника и временный пароль (D-061)', () => {
  let db: TestDb;
  let t: TestApp;
  let owner: Client;
  let ola: Client;
  let olaId: string;

  before(async () => {
    db = await createTestDb('team');
    t = await createTestApp(db);
    await createMaster(db.app, { accountName: 'Salon', email: 'owner@team.pl', password: PASSWORD });
    owner = new Client(t.url);
    await owner.post('/auth/login', { email: 'owner@team.pl', password: PASSWORD });
  });
  after(async () => {
    await t.close();
    await db.close();
  });

  test('до смены временного пароля открыты только вход, профиль и смена пароля', async () => {
    const created = await owner.post('/users', { email: 'ola@team.pl', role: 'staff', password: TEMP });
    assert.equal(created.body.mustChangePassword, true);
    olaId = created.body.id;
    ola = new Client(t.url);
    assert.equal((await ola.post('/auth/login', { email: 'ola@team.pl', password: TEMP })).status, 200);
    assert.equal((await ola.get('/auth/me')).body.mustChangePassword, true);
    assert.deepEqual((await ola.get(`/bookings?${range}`)).body, { error: 'PASSWORD_CHANGE_REQUIRED' });
    assert.equal((await ola.get('/services')).status, 403);
  });

  test('новый пароль должен отличаться; после смены доступ открыт', async () => {
    assert.equal((await ola.post('/auth/password', { currentPassword: TEMP, newPassword: TEMP })).status, 400);
    assert.equal((await ola.post('/auth/password', { currentPassword: TEMP, newPassword: 'olas own password' })).status, 204);
    assert.equal((await ola.get('/auth/me')).body.mustChangePassword, false);
    assert.equal((await ola.get(`/bookings?${range}`)).status, 200);
    assert.equal((await owner.get('/users')).body.find((u: { id: string }) => u.id === olaId).mustChangePassword, false);
  });

  test('сброс пароля owner: старый пароль не работает, текущая сессия снова требует смены', async () => {
    assert.equal((await owner.post(`/users/${olaId}/reset-password`, { password: 'new temporary 1' })).status, 204);
    assert.deepEqual((await ola.get(`/bookings?${range}`)).body, { error: 'PASSWORD_CHANGE_REQUIRED' });
    assert.equal((await new Client(t.url).post('/auth/login', { email: 'ola@team.pl', password: 'olas own password' })).status, 401);
    const again = new Client(t.url);
    assert.equal((await again.post('/auth/login', { email: 'ola@team.pl', password: 'new temporary 1' })).status, 200);
  });

  test('сбросить можно только чужой пароль и только owner', async () => {
    const me = (await owner.get('/auth/me')).body.userId;
    assert.equal((await owner.post(`/users/${me}/reset-password`, { password: 'whatever 12345' })).status, 400);
    assert.equal((await ola.post(`/users/${me}/reset-password`, { password: 'whatever 12345' })).status, 403);
    assert.equal((await owner.post(`/users/${olaId}/reset-password`, { password: 'short' })).status, 400);
  });

  test('владелец Account, созданный через CLI, пароль не меняет', async () => {
    assert.equal((await owner.get('/auth/me')).body.mustChangePassword, false);
  });
});
