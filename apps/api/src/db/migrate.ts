import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'pg';

/** Ищет папку migrations вверх от текущего файла (работает из src/, dist/ и .test-dist/). */
export function findMigrationsDir(start: string = __dirname): string {
  let dir = start;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'migrations');
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('migrations directory not found');
}

/**
 * Применяет по порядку файлы *.sql, которых ещё нет в schema_migrations. Каждая миграция идёт в своей
 * транзакции. Advisory lock защищает от одновременного запуска из двух процессов.
 * Выполняется ролью-мигратором (владельцем схемы), не ролью приложения.
 */
export async function migrate(pool: Pool, dir: string = findMigrationsDir()): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = readFileSync(path.join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${file} failed: ${(error as Error).message}`);
      }
      applied.push(file);
    }
    // Служебная таблица недоступна приложению (общий GRANT ... ON ALL TABLES её захватывает).
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rezerwapp_app') THEN
          REVOKE ALL ON schema_migrations FROM rezerwapp_app;
        END IF;
      END
      $$`);
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => undefined);
    client.release();
  }
}
