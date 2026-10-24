import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { BookingsService } from '../src/bookings/bookings.service';
import {
  ClientBlockedError,
  HoldExpiredError,
  InvalidTransitionError,
  NotFoundError,
  SlotTakenError,
  VersionConflictError,
} from '../src/bookings/errors';
import { createTestDb, seedAccount, type TestDb } from './helpers/test-db';

const T = (hhmm: string, day = '2030-03-04'): Date => new Date(`${day}T${hhmm}:00Z`);

describe('BookingsService (реальный PostgreSQL, роль приложения под RLS)', () => {
  let db: TestDb;
  let service: BookingsService;

  before(async () => {
    db = await createTestDb('bookings');
    service = new BookingsService(db.app);
  });
  after(async () => {
    await db.close();
  });

  const base = (s: Awaited<ReturnType<typeof seedAccount>>, startsAt: Date, extra = {}) => ({
    accountId: s.accountId,
    staffId: s.staffId,
    clientId: s.clientId,
    serviceId: s.serviceId,
    variantId: s.variantId,
    startsAt,
    requiresApproval: true,
    ...extra,
  });

  test('гонка: из 15 параллельных заявок на один слот проходит ровно одна', async () => {
    const s = await seedAccount(db.admin);
    const results = await Promise.allSettled(Array.from({ length: 15 }, () => service.create(base(s, T('10:00')))));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    assert.equal(ok.length, 1);
    assert.equal(rejected.length, 14);
    for (const r of rejected) assert.ok(r.reason instanceof SlotTakenError, String(r.reason));
    const count = await db.admin.query('SELECT count(*)::int AS n FROM bookings WHERE staff_id = $1', [s.staffId]);
    assert.equal(count.rows[0].n, 1);
  });

  test('длительность и буфер берутся из БД, слот включает буфер', async () => {
    const s = await seedAccount(db.admin, { durationMin: 60, bufferMin: 10 });
    const first = await service.create(base(s, T('10:00')));
    assert.equal(first.endsAt.toISOString(), '2030-03-04T11:00:00.000Z');
    await assert.rejects(service.create(base(s, T('11:00'))), SlotTakenError);
    const after = await service.create(base(s, T('11:10')));
    assert.equal(after.status, 'pending');
  });

  test('персональная длительность специалиста переопределяет вариант', async () => {
    const s = await seedAccount(db.admin, { durationMin: 60, bufferMin: 0, overrideDurationMin: 90 });
    const booking = await service.create(base(s, T('10:00')));
    assert.equal(booking.endsAt.toISOString(), '2030-03-04T11:30:00.000Z');
  });

  test('pending получает hold по политике услуги и снимок версии политики (D-015, D-017)', async () => {
    const s = await seedAccount(db.admin, { holdMinutes: 30 });
    const booking = await service.create(base(s, T('10:00')));
    assert.equal(booking.status, 'pending');
    assert.equal(booking.policyId, s.policyId);
    assert.equal(booking.policyVersion, 3);
    assert.ok(booking.holdExpiresAt);
    const minutes = (booking.holdExpiresAt.getTime() - Date.now()) / 60_000;
    assert.ok(minutes > 28 && minutes <= 30.1, `hold ≈ 30 минут, получено ${minutes}`);
  });

  test('гибридный режим: без подтверждения мастера запись сразу confirmed и без hold (D-016)', async () => {
    const s = await seedAccount(db.admin);
    const booking = await service.create(base(s, T('10:00'), { requiresApproval: false }));
    assert.equal(booking.status, 'confirmed');
    assert.equal(booking.holdExpiresAt, null);
  });

  test('просроченный hold не блокирует слот и переводится в expired с событием', async () => {
    const s = await seedAccount(db.admin);
    const stale = await service.create(base(s, T('10:00')));
    await db.admin.query("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [stale.id]);

    const fresh = await service.create(base(s, T('10:00')));
    assert.equal(fresh.status, 'pending');
    const old = await db.admin.query('SELECT status FROM bookings WHERE id = $1', [stale.id]);
    assert.equal(old.rows[0].status, 'expired');
    const events = await db.admin.query("SELECT actor FROM booking_events WHERE booking_id = $1 AND type = 'status_changed'", [stale.id]);
    assert.equal(events.rows[0].actor, 'system');
  });

  test('действующий hold блокирует слот', async () => {
    const s = await seedAccount(db.admin);
    await service.create(base(s, T('10:00')));
    await assert.rejects(service.create(base(s, T('10:30'))), SlotTakenError);
  });

  test('фоновая задача освобождает все просроченные hold Account', async () => {
    const s = await seedAccount(db.admin);
    const a = await service.create(base(s, T('10:00')));
    const b = await service.create(base(s, T('12:00')));
    await service.create(base(s, T('14:00')));
    await db.admin.query("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = ANY($1)", [[a.id, b.id]]);
    assert.equal(await service.expireStaleHolds(s.accountId), 2);
    assert.equal(await service.expireStaleHolds(s.accountId), 0);
  });

  test('blacklist: клиент с заблокированным телефоном не может записаться', async () => {
    const s = await seedAccount(db.admin);
    const hash = await db.admin.query<{ phone_hash: Buffer }>('SELECT phone_hash FROM clients WHERE id = $1', [s.clientId]);
    await db.admin.query('INSERT INTO blacklist_entries (account_id, phone_hash) VALUES ($1, $2)', [s.accountId, hash.rows[0]?.phone_hash]);
    await assert.rejects(service.create(base(s, T('10:00'))), ClientBlockedError);

    await db.admin.query("UPDATE blacklist_entries SET expires_at = now() - interval '1 day' WHERE account_id = $1", [s.accountId]);
    const booking = await service.create(base(s, T('10:00')));
    assert.equal(booking.status, 'pending');
  });

  describe('переходы статусов', () => {
    test('pending → confirmed: версия растёт, hold снимается, пишется событие', async () => {
      const s = await seedAccount(db.admin);
      const created = await service.create(base(s, T('10:00')));
      const confirmed = await service.transition({ accountId: s.accountId, bookingId: created.id, to: 'confirmed', actor: 'master' });
      assert.equal(confirmed.status, 'confirmed');
      assert.equal(confirmed.version, created.version + 1);
      assert.equal(confirmed.holdExpiresAt, null);
      const events = await db.admin.query('SELECT type, actor, payload FROM booking_events WHERE booking_id = $1 ORDER BY id', [created.id]);
      assert.deepEqual(events.rows.map((e) => e.type), ['created', 'status_changed']);
      assert.deepEqual(events.rows[1].payload, { from: 'pending', to: 'confirmed' });
    });

    test('недопустимый переход отклоняется, статус не меняется', async () => {
      const s = await seedAccount(db.admin);
      const created = await service.create(base(s, T('10:00'), { requiresApproval: false }));
      await assert.rejects(
        service.transition({ accountId: s.accountId, bookingId: created.id, to: 'rejected', actor: 'master' }),
        InvalidTransitionError,
      );
      const done = await service.transition({ accountId: s.accountId, bookingId: created.id, to: 'completed', actor: 'master' });
      await assert.rejects(
        service.transition({ accountId: s.accountId, bookingId: done.id, to: 'confirmed', actor: 'master' }),
        InvalidTransitionError,
      );
    });

    test('оптимистичная блокировка: устаревшая версия отклоняется', async () => {
      const s = await seedAccount(db.admin);
      const created = await service.create(base(s, T('10:00')));
      await assert.rejects(
        service.transition({ accountId: s.accountId, bookingId: created.id, to: 'confirmed', actor: 'master', expectedVersion: created.version + 5 }),
        VersionConflictError,
      );
      const ok = await service.transition({ accountId: s.accountId, bookingId: created.id, to: 'confirmed', actor: 'master', expectedVersion: created.version });
      assert.equal(ok.status, 'confirmed');
    });

    test('подтвердить заявку с истёкшим hold нельзя', async () => {
      const s = await seedAccount(db.admin);
      const created = await service.create(base(s, T('10:00')));
      await db.admin.query("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [created.id]);
      await assert.rejects(
        service.transition({ accountId: s.accountId, bookingId: created.id, to: 'confirmed', actor: 'master' }),
        HoldExpiredError,
      );
    });

    test('отмена и отклонение освобождают слот', async () => {
      const s = await seedAccount(db.admin);
      const a = await service.create(base(s, T('10:00')));
      await service.transition({ accountId: s.accountId, bookingId: a.id, to: 'rejected', actor: 'master' });
      const b = await service.create(base(s, T('10:00')));
      await service.transition({ accountId: s.accountId, bookingId: b.id, to: 'confirmed', actor: 'master' });
      await service.transition({ accountId: s.accountId, bookingId: b.id, to: 'cancelled_by_client', actor: 'client' });
      const c = await service.create(base(s, T('10:00')));
      assert.equal(c.status, 'pending');
    });
  });

  describe('изоляция Account', () => {
    test('нельзя записать к специалисту и клиенту другого Account', async () => {
      const mine = await seedAccount(db.admin);
      const other = await seedAccount(db.admin);
      await assert.rejects(
        service.create({ ...base(other, T('10:00')), accountId: mine.accountId }),
        NotFoundError,
      );
      const count = await db.admin.query('SELECT count(*)::int AS n FROM bookings WHERE account_id = ANY($1)', [[mine.accountId, other.accountId]]);
      assert.equal(count.rows[0].n, 0);
    });

    test('нельзя изменить запись другого Account', async () => {
      const mine = await seedAccount(db.admin);
      const other = await seedAccount(db.admin);
      const theirs = await service.create(base(other, T('10:00')));
      await assert.rejects(
        service.transition({ accountId: mine.accountId, bookingId: theirs.id, to: 'confirmed', actor: 'master' }),
        NotFoundError,
      );
      const row = await db.admin.query('SELECT status FROM bookings WHERE id = $1', [theirs.id]);
      assert.equal(row.rows[0].status, 'pending');
    });

    test('фоновая задача одного Account не трогает hold другого', async () => {
      const mine = await seedAccount(db.admin);
      const other = await seedAccount(db.admin);
      const theirs = await service.create(base(other, T('10:00')));
      await db.admin.query("UPDATE bookings SET hold_expires_at = now() - interval '1 minute' WHERE id = $1", [theirs.id]);
      assert.equal(await service.expireStaleHolds(mine.accountId), 0);
      const row = await db.admin.query('SELECT status FROM bookings WHERE id = $1', [theirs.id]);
      assert.equal(row.rows[0].status, 'pending');
    });
  });
});
