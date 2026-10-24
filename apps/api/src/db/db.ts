import { Pool, type PoolClient } from 'pg';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createPool(connectionString: string, max = 10): Pool {
  return new Pool({ connectionString, max });
}

/**
 * Доступ к БД от имени роли приложения. Каждая операция идёт в транзакции с объявленным Account:
 * set_config('app.account_id', ..., true) действует только до конца транзакции, а Row-Level Security
 * (миграция 0001) фильтрует строки по этому значению. Без контекста строки не видны.
 */
export class Db {
  constructor(readonly pool: Pool) {}

  async withAccount<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(accountId)) throw new Error('withAccount: accountId must be a UUID');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
