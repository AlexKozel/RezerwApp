import { describeError } from '../cli/describe-error';
import { createPool } from './db';
import { migrate } from './migrate';

async function main(): Promise<void> {
  const url = process.env.MIGRATOR_DATABASE_URL;
  if (!url) throw new Error('MIGRATOR_DATABASE_URL is not set');
  const pool = createPool(url, 1);
  try {
    const applied = await migrate(pool);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exit(1);
});
