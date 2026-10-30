import { addDays, localDate, zonedToUtc } from '@rezerwapp/shared';
import type { Pool } from 'pg';
import { AccountSettingsService } from '../accounts/account-settings.service';
import { createMaster } from '../auth/auth.service';
import { UsersService } from '../auth/users.service';
import { AvailabilityService } from '../availability/availability.service';
import { BookingsService } from '../bookings/bookings.service';
import { CatalogService } from '../catalog/catalog.service';
import { ClientsService } from '../clients/clients.service';
import { loadConfig } from '../config';
import { FieldCipher } from '../crypto/field-cipher';
import { EnvKeyProvider } from '../crypto/key-provider';
import { PhoneHasher } from '../crypto/phone-hash';
import { Db, createPool } from '../db/db';
import { LegalService, PLATFORM_DOCUMENTS, publishLegal } from '../legal/legal.service';
import { describeError } from './describe-error';

/**
 * Демо-данные для локального запуска (pnpm dev:all, pnpm demo:reset). Только для разработки: пароли известны
 * и печатаются в консоль. Создаются через сервисы приложения (RLS, шифрование телефонов, проверки), а не SQL.
 *
 *   node dist/cli/demo.js seed    # создать, если ещё нет
 *   node dist/cli/demo.js reset   # удалить демо-Account и создать заново
 */
export const DEMO = {
  owner: { email: 'demo@rezerwapp.local', password: 'demo-owner-pass' },
  staff: { email: 'kasia@rezerwapp.local', password: 'demo-staff-pass' },
  slug: 'demo-studio',
  staffSlug: 'demo-kasia',
  legalVersion: 'dev-1',
};

async function findDemoAccount(migrator: Pool): Promise<string | null> {
  const row = (await migrator.query<{ id: string }>('SELECT id FROM admin_accounts() WHERE owners = $1', [DEMO.owner.email])).rows[0];
  return row?.id ?? null;
}

/** Удаление демо-Account. Записи ссылаются на специалистов без каскада, поэтому сначала они. */
async function removeDemo(migrator: Pool, accountId: string): Promise<void> {
  const client = await migrator.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
    await client.query('DELETE FROM notification_log WHERE account_id = $1', [accountId]);
    await client.query('DELETE FROM bookings WHERE account_id = $1', [accountId]);
    await client.query('DELETE FROM accounts WHERE id = $1', [accountId]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seed(db: Db, migrator: Pool): Promise<void> {
  const config = loadConfig();
  const hasher = new PhoneHasher(config.phoneHashPepper);
  const cipher = new FieldCipher(new EnvKeyProvider(config.fieldMasterKey));
  const catalog = new CatalogService(db);
  const availability = new AvailabilityService(db);
  const bookings = new BookingsService(db);
  const clients = new ClientsService(hasher, cipher);

  // Тексты-заглушки из legal/: без них публичная запись отвечает LEGAL_TEXTS_MISSING (D-055).
  await publishLegal(migrator, DEMO.legalVersion);

  const { accountId, userId } = await createMaster(db, { accountName: 'Demo Studio', email: DEMO.owner.email, password: DEMO.owner.password });
  const legal = new LegalService(db, hasher);
  const pending = await legal.pending(accountId);
  await legal.accept(accountId, userId, pending.filter((d) => (PLATFORM_DOCUMENTS as readonly string[]).includes(d.type)), '127.0.0.1');
  await new AccountSettingsService(db).updatePayment(accountId, { blikPhone: '600700800', recipient: 'Demo Studio' });

  const anna = (await catalog.createStaff(accountId, { displayName: 'Anna', publicSlug: DEMO.slug })).id;
  const kasia = (await catalog.createStaff(accountId, { displayName: 'Kasia', publicSlug: DEMO.staffSlug })).id;
  const users = new UsersService(db);
  const staffUser = await users.create(accountId, { email: DEMO.staff.email, role: 'staff', password: 'temporary-pass-1', staffId: kasia });
  // Демо: сотрудник сразу со своим паролем, без обязательной смены (D-061 проверяется тестами).
  await users.changePassword(accountId, staffUser.id, 'temporary-pass-1', DEMO.staff.password);

  // Hold на максимум (сутки, CHECK в БД): иначе демо-заявка истекает через 2 часа после запуска и пропадает из заявок.
  const policy = await catalog.createPolicy(accountId, { freeCancelHours: 24, maxReschedules: 1, holdMinutes: 1440, depositOnLateCancel: 'keep', texts: {} });
  const base = { category: null, prepaymentMethod: 'none' as const, depositMode: 'none' as const, depositValue: 0, depositScope: 'new_clients' as const, cancelPolicyId: policy.id, costPrice: null };
  const manicure = await catalog.createService(
    accountId,
    { ...base, name: { pl: 'Manicure hybrydowy', uk: 'Гібридний манікюр', ru: 'Гибридный маникюр', en: 'Gel manicure' }, requiresManualConfirm: false, costPrice: 25 },
    [
      { name: { pl: 'Krótkie paznokcie', uk: 'Короткі нігті', ru: 'Короткие ногти', en: 'Short nails' }, durationMin: 60, bufferMin: 15, price: 120 },
      { name: { pl: 'Długie paznokcie', uk: 'Довгі нігті', ru: 'Длинные ногти', en: 'Long nails' }, durationMin: 90, bufferMin: 15, price: 150 },
    ],
  );
  const lashes = await catalog.createService(
    accountId,
    {
      ...base,
      name: { pl: 'Przedłużanie rzęs', uk: 'Нарощування вій', ru: 'Наращивание ресниц', en: 'Eyelash extensions' },
      requiresManualConfirm: true,
      prepaymentMethod: 'manual_blik',
      depositMode: 'fixed',
      depositValue: 40,
    },
    [{ name: {}, durationMin: 120, bufferMin: 0, price: 250 }],
  );
  const henna = await catalog.createService(
    accountId,
    { ...base, name: { pl: 'Henna brwi', uk: 'Хна для брів', ru: 'Хна для бровей', en: 'Brow henna' }, requiresManualConfirm: false },
    [{ name: {}, durationMin: 30, bufferMin: 0, price: 60 }],
  );
  for (const staff of [anna, kasia]) {
    for (const s of [manicure, lashes, henna]) await catalog.assignStaff(accountId, staff, s.service.id, { durationMin: null, price: null });
    await availability.setWorkingHours(accountId, staff, [
      ...[1, 2, 3, 4, 5].map((weekday) => ({ weekday, start: 9 * 60, end: 18 * 60 })),
      { weekday: 6, start: 10 * 60, end: 15 * 60 },
    ]);
  }

  // Клиенты и записи: вчерашний завершённый визит (для «Результатов»), сегодня и завтра, заявка с оплатой.
  const people = [
    { name: 'Zofia Nowak', phone: '+48 501 111 222', language: 'pl' as const },
    { name: 'Олена Коваль', phone: '+48 502 333 444', language: 'uk' as const },
    { name: 'Marta Wiśniewska', phone: '+48 503 555 666', language: 'pl' as const },
  ];
  const ids: string[] = [];
  for (const p of people) ids.push((await db.withAccount(accountId, (c) => clients.findOrCreate(c, accountId, p))).id);

  const tz = 'Europe/Warsaw';
  const today = localDate(new Date(), tz);
  // Дни рождения (D-065): у Zofia сегодня (видно напоминание в календаре), у Marta через 3 дня.
  for (const [index, date] of [[0, today], [2, addDays(today, 3)]] as const) {
    await db.withAccount(accountId, (c) =>
      c.query('UPDATE clients SET birth_month = $2, birth_day = $3 WHERE id = $1', [ids[index], Number(date.slice(5, 7)), Number(date.slice(8, 10))]),
    );
  }
  const at = (day: string, hour: number) => zonedToUtc(day, hour * 60, tz)!;
  const book = (staffId: string, service: typeof manicure, clientIndex: number, startsAt: Date, approval = false) =>
    bookings.create({
      accountId,
      staffId,
      clientId: ids[clientIndex]!,
      serviceId: service.service.id,
      variantId: service.service.variants[0]!.id,
      startsAt,
      requiresApproval: approval,
      actor: 'master',
    });

  const past = await book(anna, manicure, 0, at(addDays(today, -1), 10));
  await bookings.transition({ accountId, bookingId: past.id, to: 'completed', actor: 'master' });
  // «Ненадёжная» клиентка (D-066): у Marta две неявки; предоплата 20% для ненадёжных включена, в виджете
  // с её номером (+48 503 555 666) запись попросит оплату.
  for (const days of [-20, -10]) {
    const missed = await book(anna, henna, 2, at(addDays(today, days), 14));
    await bookings.transition({ accountId, bookingId: missed.id, to: 'no_show', actor: 'master' });
  }
  await new AccountSettingsService(db).updateReliability(accountId, { depositPercent: 20 });
  // Лист ожидания (D-068): Zofia ждёт наращивание ресниц у Anna на неделе; фоновая задача предложит ей окно.
  await db.withAccount(accountId, (c) =>
    c.query(
      `INSERT INTO waitlist_entries (account_id, staff_id, client_id, service_id, variant_id, date_from, date_to, part_of_day)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'any')`,
      [accountId, anna, ids[0], lashes.service.id, lashes.service.variants[0]!.id, addDays(today, 1), addDays(today, 7)],
    ),
  );
  // Сегодняшний визит, если день ещё не закончился.
  if (at(today, 16) > new Date()) await book(anna, manicure, 1, at(today, 16));
  await book(anna, henna, 2, at(addDays(today, 1), 11));
  await book(kasia, manicure, 0, at(addDays(today, 1), 13));
  // Заявка с резервационной оплатой, ждёт подтверждения мастера.
  const request = await book(anna, lashes, 1, at(addDays(today, 2), 12), true);
  await db.withAccount(accountId, (c) =>
    c.query("INSERT INTO payment_requests (account_id, booking_id, mode, amount, code) VALUES ($1, $2, 'manual_blik', 40, 'DEMO')", [accountId, request.id]),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'seed';
  const appUrl = process.env.DATABASE_URL;
  const migratorUrl = process.env.MIGRATOR_DATABASE_URL;
  if (!appUrl || !migratorUrl) throw new Error('DATABASE_URL and MIGRATOR_DATABASE_URL must be set');
  const db = new Db(createPool(appUrl, 4));
  const migrator = createPool(migratorUrl, 2);
  try {
    const existing = await findDemoAccount(migrator);
    if (command === 'reset' && existing) {
      await removeDemo(migrator, existing);
      console.log('demo: removed');
    }
    if (command === 'reset' || !existing) {
      await seed(db, migrator);
      console.log('demo: created');
    } else {
      console.log('demo: already exists');
    }
  } finally {
    await db.close();
    await migrator.end();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(describeError(error));
    process.exit(1);
  });
}
