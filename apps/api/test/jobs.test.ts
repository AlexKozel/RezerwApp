import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { Redis } from 'ioredis';
import { BookingsService } from '../src/bookings/bookings.service';
import { MASTER_REMINDER_AFTER_MIN, MaintenanceJobs } from '../src/jobs/maintenance';
import type { BookingNotification, Notifier } from '../src/jobs/notifier';
import { JobScheduler } from '../src/jobs/scheduler';
import { TEST_REDIS_URL } from './helpers/app';
import { createTestDb, seedAccount, type Seed, type TestDb } from './helpers/test-db';

class RecordingNotifier implements Notifier {
  readonly events: BookingNotification[] = [];
  async notify(event: BookingNotification): Promise<void> {
    this.events.push(event);
  }
}

const T = (hhmm: string, day = '2030-05-06'): Date => new Date(`${day}T${hhmm}:00Z`);

describe('фоновые задачи (D-017, D-049)', () => {
  let db: TestDb;
  let bookings: BookingsService;

  before(async () => {
    db = await createTestDb('jobs');
    bookings = new BookingsService(db.app);
  });
  after(async () => {
    await db.close();
  });

  const pending = (s: Seed, startsAt: Date) =>
    bookings.create({ accountId: s.accountId, staffId: s.staffId, clientId: s.clientId, serviceId: s.serviceId, variantId: s.variantId, startsAt, requiresApproval: true });
  const age = (id: string, minutes: number) => db.admin.query(`UPDATE bookings SET created_at = now() - make_interval(mins => $2) WHERE id = $1`, [id, minutes]);
  const expire = (id: string) => db.admin.query("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [id]);
  const status = async (id: string) => (await db.admin.query('SELECT status FROM bookings WHERE id = $1', [id])).rows[0].status;

  test('истекает hold, мастеру напоминают один раз, по всем Account; повтор ничего не делает', async () => {
    const a = await seedAccount(db.admin);
    const b = await seedAccount(db.admin);
    const staleA = await pending(a, T('09:00'));
    const waitingA = await pending(a, T('11:00'));
    const freshA = await pending(a, T('13:00'));
    const staleB = await pending(b, T('09:00'));
    await expire(staleA.id);
    await expire(staleB.id);
    await age(waitingA.id, MASTER_REMINDER_AFTER_MIN + 5);
    await age(freshA.id, MASTER_REMINDER_AFTER_MIN - 5);

    const notifier = new RecordingNotifier();
    const jobs = new MaintenanceJobs(db.app, bookings, notifier);
    const first = await jobs.run();
    assert.ok(first.accounts >= 2);
    assert.equal(first.expired, 2);
    assert.equal(first.reminded, 1);
    assert.equal(await status(staleA.id), 'expired');
    assert.equal(await status(staleB.id), 'expired');
    assert.equal(await status(waitingA.id), 'pending');
    assert.deepEqual(
      notifier.events.map((e) => [e.type, e.bookingId]).sort(),
      [
        ['booking.expired', staleA.id],
        ['booking.expired', staleB.id],
        ['booking.master_reminder', waitingA.id],
      ].sort(),
    );

    const second = await jobs.run();
    assert.deepEqual([second.expired, second.reminded], [0, 0]);
    assert.equal(notifier.events.length, 3);
  });

  test('два воркера одновременно не отправляют одно напоминание дважды', async () => {
    const s = await seedAccount(db.admin);
    const ids = await Promise.all(['08:00', '10:00', '12:00', '14:00'].map((t) => pending(s, T(t, '2030-05-07'))));
    for (const b of ids) await age(b.id, 45);
    const notifier = new RecordingNotifier();
    const [x, y] = await Promise.all([
      new MaintenanceJobs(db.app, bookings, notifier).run(),
      new MaintenanceJobs(db.app, bookings, notifier).run(),
    ]);
    assert.equal(x.reminded + y.reminded, 4);
    const reminded = notifier.events.filter((e) => e.type === 'booking.master_reminder').map((e) => e.bookingId);
    assert.equal(new Set(reminded).size, 4);
    const events = await db.admin.query("SELECT count(*)::int AS n FROM booking_events WHERE type = 'master_reminded' AND booking_id = ANY($1)", [ids.map((b) => b.id)]);
    assert.equal(events.rows[0].n, 4);
  });

  test('сбой уведомления не откатывает истечение hold', async () => {
    const s = await seedAccount(db.admin);
    const b = await pending(s, T('09:00', '2030-05-08'));
    await expire(b.id);
    const failing: Notifier = { notify: async () => Promise.reject(new Error('channel down')) };
    const result = await new MaintenanceJobs(db.app, bookings, failing).run();
    assert.ok(result.expired >= 1);
    assert.equal(await status(b.id), 'expired');
  });

  test('функция поиска Account возвращает только id и недоступна PUBLIC', async () => {
    const cols = await db.app.pool.query('SELECT * FROM jobs_accounts_with_pending() LIMIT 1');
    assert.deepEqual(cols.fields.map((f) => f.name), ['jobs_accounts_with_pending']);
    const fn = await db.admin.query(
      "SELECT p.prosecdef, p.proconfig, has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec FROM pg_proc p WHERE proname = 'jobs_accounts_with_pending'",
    );
    assert.deepEqual(fn.rows[0], { prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'], public_exec: false });
    // Роль приложения по-прежнему не видит записи без контекста Account.
    assert.equal((await db.app.pool.query('SELECT count(*)::int AS n FROM bookings')).rows[0].n, 0);
  });

  test('BullMQ: повторяющаяся задача запускается и освобождает hold', async () => {
    const s = await seedAccount(db.admin);
    const b = await pending(s, T('09:00', '2030-05-09'));
    await expire(b.id);
    const prefix = `test-bull-${randomBytes(4).toString('hex')}`;
    const scheduler = new JobScheduler(new MaintenanceJobs(db.app, bookings, new RecordingNotifier()), {
      redisUrl: TEST_REDIS_URL,
      prefix,
      everyMs: 200,
    });
    await scheduler.onApplicationBootstrap();
    try {
      const done = scheduler.nextCompleted();
      await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error('job did not run in 10 s')), 10_000))]);
      assert.equal(await status(b.id), 'expired');
    } finally {
      await scheduler.onApplicationShutdown();
      const redis = new Redis(TEST_REDIS_URL);
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
    }
  });
});
