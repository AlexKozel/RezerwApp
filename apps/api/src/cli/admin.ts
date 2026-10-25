import { PlatformAdmin, type AccountStatus } from '../admin/admin';
import { createPool } from '../db/db';
import { describeError } from './describe-error';

const USAGE = `Администрирование платформы (D-057), ролью-мигратором (MIGRATOR_DATABASE_URL):

  pnpm admin accounts                     список Account
  pnpm admin show <account>               карточка: пользователи, специалисты, адреса, документы
  pnpm admin suspend <account>            приостановить (вход, сессии, страницы и запись закрываются)
  pnpm admin activate <account>           вернуть доступ
  pnpm admin close <account>              закрыть (данные не удаляются)
  pnpm admin plan <account> <plan> <sms>  план и месячный пакет SMS
  pnpm admin add-sms <account> <count>    докупленный пакет SMS на этот месяц`;

const STATUS: Record<string, AccountStatus> = { suspend: 'suspended', activate: 'active', close: 'closed' };

async function main(): Promise<void> {
  const [command, accountId, ...rest] = process.argv.slice(2);
  if (!command || command === 'help') {
    console.log(USAGE);
    return;
  }
  const url = process.env.MIGRATOR_DATABASE_URL;
  if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');
  const pool = createPool(url, 2);
  const admin = new PlatformAdmin(pool);
  try {
    if (command === 'accounts') {
      console.table(
        (await admin.accounts()).map((a) => ({
          id: a.id,
          name: a.name,
          status: a.status,
          plan: a.plan,
          owners: a.owners,
          staff: a.staff_count,
          'bookings 30d': a.bookings_30d,
          sms: `${a.sms_used_month}/${a.sms_included}`,
        })),
      );
    } else if (command === 'show' && accountId) {
      console.dir(await admin.account(accountId), { depth: 3 });
    } else if (STATUS[command] && accountId) {
      await admin.setStatus(accountId, STATUS[command]);
      console.log(`account ${accountId}: ${STATUS[command]}`);
    } else if (command === 'plan' && accountId && rest.length === 2) {
      await admin.setPlan(accountId, rest[0]!, Number(rest[1]));
      console.log(`account ${accountId}: plan ${rest[0]}, ${rest[1]} SMS/month`);
    } else if (command === 'add-sms' && accountId && rest.length === 1) {
      await admin.addSms(accountId, Number(rest[0]), 'admin');
      console.log(`account ${accountId}: +${rest[0]} SMS`);
    } else {
      console.log(USAGE);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
