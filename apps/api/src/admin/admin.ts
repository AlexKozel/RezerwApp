import type { Pool, PoolClient } from 'pg';
import { audit } from '../audit';
import { NotFoundError, ValidationError } from '../errors';

export type AccountStatus = 'active' | 'suspended' | 'closed';

export interface AccountRow {
  id: string;
  name: string;
  status: AccountStatus;
  plan: string;
  sms_included: number;
  created_at: Date;
  owners: string | null;
  staff_count: number;
  bookings_30d: number;
  sms_used_month: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Операции администратора платформы (D-005, D-057) ролью-мигратором. Список всех Account даёт функция
 * admin_accounts (миграция 0012), остальное выполняется в контексте конкретного Account: RLS и FORCE RLS
 * действуют и для владельца схемы, поэтому админ видит и меняет только тот Account, который назвал.
 * Клиентов, записей и заметок админ не читает (DATA_MODEL.md, раздел 4); действия пишутся в журнал Account.
 */
export class PlatformAdmin {
  constructor(private readonly pool: Pool) {}

  async accounts(): Promise<AccountRow[]> {
    return (await this.pool.query<AccountRow>('SELECT * FROM admin_accounts()')).rows;
  }

  /** Карточка для поддержки: пользователи, специалисты, адреса, принятые документы. Без клиентских данных. */
  async account(accountId: string) {
    return this.inAccount(accountId, async (client) => {
      const row = (await this.accounts()).find((a) => a.id === accountId)!;
      const users = await client.query('SELECT email, role, created_at FROM users ORDER BY created_at');
      const staff = await client.query('SELECT display_name, public_slug, active FROM staff ORDER BY created_at');
      const locations = await client.query('SELECT name, public_slug FROM locations ORDER BY created_at');
      const accepted = await client.query('SELECT document_type, version, accepted_at FROM platform_acceptances ORDER BY accepted_at');
      return { ...row, users: users.rows, staff: staff.rows, locations: locations.rows, acceptedDocuments: accepted.rows };
    });
  }

  /**
   * Приостановка или закрытие закрывает вход, действующие сессии (SessionGuard), публичные страницы и запись.
   * Данные Account не удаляются.
   */
  async setStatus(accountId: string, status: AccountStatus): Promise<void> {
    await this.inAccount(accountId, async (client) => {
      await client.query('UPDATE accounts SET status = $2 WHERE id = $1', [accountId, status]);
      await audit(client, accountId, null, `admin.${status}`, 'account', accountId);
    });
  }

  /** План и месячный пакет SMS (D-002, D-003, D-005: доступ и план выдаются вручную). */
  async setPlan(accountId: string, plan: string, smsIncluded: number): Promise<void> {
    if (!/^[a-z0-9_-]{1,30}$/.test(plan)) throw new ValidationError({ plan: 'a-z, 0-9, _ and -, up to 30' });
    if (!Number.isInteger(smsIncluded) || smsIncluded < 0 || smsIncluded > 100_000) throw new ValidationError({ sms: '0..100000' });
    await this.inAccount(accountId, async (client) => {
      await client.query('UPDATE accounts SET plan = $2, sms_included = $3 WHERE id = $1', [accountId, plan, smsIncluded]);
      await audit(client, accountId, null, 'admin.plan', 'account', accountId);
    });
  }

  /** Докупленный пакет SMS на текущий месяц (D-003). */
  async addSms(accountId: string, count: number, reason: string): Promise<void> {
    if (!Number.isInteger(count) || count <= 0 || count > 100_000) throw new ValidationError({ count: '1..100000' });
    await this.inAccount(accountId, async (client) => {
      await client.query('INSERT INTO sms_ledger (account_id, delta, reason) VALUES ($1, $2, $3)', [accountId, count, `purchase:${reason}`.slice(0, 200)]);
      await audit(client, accountId, null, 'admin.sms', 'account', accountId);
    });
  }

  private async inAccount<T>(accountId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    if (!UUID_RE.test(accountId)) throw new ValidationError({ account: 'expected an account id (uuid)' });
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.account_id', $1, true)", [accountId]);
      const exists = await client.query('SELECT 1 FROM accounts WHERE id = $1', [accountId]);
      if (exists.rowCount === 0) throw new NotFoundError('account');
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
}
