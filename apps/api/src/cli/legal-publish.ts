import { readdirSync } from 'node:fs';
import path from 'node:path';
import { createPool } from '../db/db';
import { findLegalDir, publishLegal } from '../legal/legal.service';
import { describeError } from './describe-error';

/**
 * Публикация юридических текстов из legal/ (D-055). Ролью-мигратором: приложению запись в consent_documents запрещена.
 *
 *   pnpm legal:publish             # показать, что будет опубликовано
 *   pnpm legal:publish 2026-11-01  # опубликовать как версию 2026-11-01
 *
 * Версия передаётся аргументом, а не флагом: pnpm перехватывает --version как собственный.
 */
async function main(): Promise<void> {
  const version = process.argv.slice(2).find((a) => !a.startsWith('-'));
  const dir = findLegalDir();

  if (!version) {
    console.log(`Тексты в ${dir}:`);
    for (const type of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      const files = readdirSync(path.join(dir, type.name)).filter((f) => f.endsWith('.md'));
      console.log(`  ${type.name}: ${files.map((f) => f.replace('.md', '')).join(', ')}`);
    }
    console.log('Чтобы опубликовать: pnpm legal:publish <версия, например 2026-11-01>');
    return;
  }

  const url = process.env.MIGRATOR_DATABASE_URL;
  if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');
  const pool = createPool(url, 1);
  try {
    const result = await publishLegal(pool, version, dir);
    const show = (items: Array<{ type: string; language: string }>) => items.map((x) => `${x.type}/${x.language}`).join(', ') || '-';
    console.log(`published ${version}: ${show(result.published)}`);
    console.log(`unchanged: ${show(result.unchanged)}`);
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
