import { createInterface } from 'node:readline';
import { isLocale } from '@rezerwapp/shared';
import { createMaster } from '../auth/auth.service';
import { CatalogService } from '../catalog/catalog.service';
import { Db, createPool } from '../db/db';
import { describeError } from './describe-error';

/**
 * Выдача доступа мастеру в alpha (D-005: вручную, без публичной регистрации).
 *
 *   pnpm create-master --email anna@example.pl --account "Anna Nails" [--slug anna-nails] [--name "Anna"] [--locale pl]
 *
 * Пароль читается из MASTER_PASSWORD или из первой строки stdin, чтобы не попадать в историю shell.
 * С --slug сразу создаётся специалист с публичной ссылкой (типичный случай Solo).
 */
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readPassword(): Promise<string> {
  if (process.env.MASTER_PASSWORD) return process.env.MASTER_PASSWORD;
  process.stderr.write('Password: ');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line;
  }
  return '';
}

async function main(): Promise<void> {
  const email = arg('email');
  const accountName = arg('account');
  const locale = arg('locale') ?? 'pl';
  if (!email || !accountName || !isLocale(locale)) {
    throw new Error('usage: create-master --email <email> --account <name> [--slug <slug>] [--name <display name>] [--locale pl|uk|ru|en]');
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const db = new Db(createPool(url, 2));
  try {
    const { accountId, userId } = await createMaster(db, { accountName, email, password: await readPassword(), locale });
    console.log(`account ${accountId}, owner ${userId}`);
    const slug = arg('slug');
    if (slug) {
      const staff = await new CatalogService(db).createStaff(accountId, { displayName: arg('name') ?? accountName, publicSlug: slug });
      console.log(`staff ${staff.id}, public link /${slug}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
