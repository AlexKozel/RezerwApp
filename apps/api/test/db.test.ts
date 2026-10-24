import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';
import { after, before, describe, test } from 'node:test';
import { createTestDb, type TestDb } from './helpers/test-db';

describe('пул соединений', () => {
  let db: TestDb;

  before(async () => {
    db = await createTestDb('db');
  });
  after(async () => {
    await db.close();
  });

  test('обрыв простаивающего соединения не роняет процесс, пул переподключается', async () => {
    const pid = (await db.app.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
    assert.ok(pid);
    // Свой слушатель 'error' здесь не вешаем: он скрыл бы отсутствие обработчика в createPool.
    await db.admin.query('SELECT pg_terminate_backend($1)', [pid]);
    for (let i = 0; i < 50 && db.app.pool.totalCount > 0; i += 1) await setTimeout(20);
    assert.equal(db.app.pool.totalCount, 0, 'пул отбросил оборванное соединение');

    const again = await db.app.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.notEqual(again.rows[0]?.pid, pid);
  });
});
