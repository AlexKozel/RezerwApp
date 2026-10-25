import type { PoolClient } from 'pg';

/** D-003: предупреждение мастеру при использовании 80% пакета SMS. */
export const SMS_WARN_PERCENT = 80;

export interface SmsUsage {
  allowance: number;
  used: number;
  remaining: number;
  percent: number;
}

/**
 * Учёт SMS Account (D-003): пакет на месяц (accounts.sms_included) плюс докупленное в этом месяце
 * (sms_ledger, delta > 0) минус отправленное (delta < 0). Месяц календарный по UTC.
 * Вызывается в транзакции withAccount.
 */
export async function smsUsage(client: PoolClient): Promise<SmsUsage> {
  const row = (await client.query<{ included: number; purchased: number; used: number }>(
    `SELECT a.sms_included AS included,
            COALESCE(sum(l.delta) FILTER (WHERE l.delta > 0), 0)::int AS purchased,
            COALESCE(-sum(l.delta) FILTER (WHERE l.delta < 0), 0)::int AS used
       FROM accounts a
       LEFT JOIN sms_ledger l ON l.account_id = a.id AND l.at >= date_trunc('month', now())
      GROUP BY a.sms_included`,
  )).rows[0];
  const allowance = (row?.included ?? 0) + (row?.purchased ?? 0);
  const used = row?.used ?? 0;
  return { allowance, used, remaining: allowance - used, percent: allowance > 0 ? Math.floor((used / allowance) * 100) : 100 };
}

export async function chargeSms(client: PoolClient, accountId: string, template: string): Promise<SmsUsage> {
  await client.query('INSERT INTO sms_ledger (account_id, delta, reason) VALUES ($1, -1, $2)', [accountId, `sent:${template}`]);
  return smsUsage(client);
}
