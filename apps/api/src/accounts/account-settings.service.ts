import { normalizePhone } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import type { Db } from '../db/db';
import { ValidationError } from '../errors';

export interface PaymentSettings {
  /** Номер BLIK в E.164, на который клиенты переводят резервационную оплату (D-010, D-048). */
  blikPhone: string | null;
  /** Имя получателя, которое клиент увидит в банковском приложении. */
  recipient: string | null;
}

/** Правила «ненадёжного клиента» (D-066). depositPercent: предоплата для ненадёжных, % цены; null = выключено. */
export interface ReliabilitySettings {
  threshold: number;
  redeemVisits: number;
  depositPercent: number | null;
}

/** Настройки Account, которые меняет только owner. */
export class AccountSettingsService {
  constructor(private readonly db: Db) {}

  async getPayment(accountId: string): Promise<PaymentSettings> {
    return this.db.withAccount(accountId, (client) => readPayment(client));
  }

  /** null очищает поле. Номер нельзя убрать, пока хотя бы одна активная услуга требует оплату manual_blik. */
  async updatePayment(accountId: string, patch: { blikPhone?: string | null; recipient?: string | null }): Promise<PaymentSettings> {
    let blikPhone: string | null | undefined = patch.blikPhone;
    if (typeof blikPhone === 'string') {
      blikPhone = normalizePhone(blikPhone);
      if (!blikPhone) throw new ValidationError({ blikPhone: 'invalid phone number' });
    }
    return this.db.withAccount(accountId, async (client) => {
      if (blikPhone === null) {
        const used = await client.query("SELECT 1 FROM services WHERE active AND prepayment_method = 'manual_blik' AND deposit_mode <> 'none' LIMIT 1");
        if ((used.rowCount ?? 0) > 0) throw new ValidationError({ blikPhone: 'used by services with a BLIK booking fee' });
        const unreliable = await client.query('SELECT 1 FROM accounts WHERE unreliable_deposit_percent IS NOT NULL');
        if ((unreliable.rowCount ?? 0) > 0) throw new ValidationError({ blikPhone: 'used by the booking fee for unreliable clients' });
      }
      await client.query(
        `UPDATE accounts SET blik_phone = CASE WHEN $2 THEN $3 ELSE blik_phone END,
                             payment_recipient = CASE WHEN $4 THEN $5 ELSE payment_recipient END
          WHERE id = $1`,
        [accountId, blikPhone !== undefined, blikPhone ?? null, patch.recipient !== undefined, patch.recipient ?? null],
      );
      return readPayment(client);
    });
  }

  async getReliability(accountId: string): Promise<ReliabilitySettings> {
    return this.db.withAccount(accountId, (client) => readReliability(client));
  }

  /** Предоплату для ненадёжных можно включить только с номером BLIK: иначе клиенту некуда платить (D-048). */
  async updateReliability(accountId: string, patch: Partial<ReliabilitySettings>): Promise<ReliabilitySettings> {
    return this.db.withAccount(accountId, async (client) => {
      if (patch.depositPercent !== undefined && patch.depositPercent !== null && !(await readPayment(client)).blikPhone) {
        throw new ValidationError({ depositPercent: 'set a BLIK phone first' });
      }
      await client.query(
        `UPDATE accounts SET unreliable_threshold = COALESCE($2, unreliable_threshold),
                             unreliable_redeem_visits = COALESCE($3, unreliable_redeem_visits),
                             unreliable_deposit_percent = CASE WHEN $4 THEN $5::smallint ELSE unreliable_deposit_percent END
          WHERE id = $1`,
        [accountId, patch.threshold ?? null, patch.redeemVisits ?? null, patch.depositPercent !== undefined, patch.depositPercent ?? null],
      );
      return readReliability(client);
    });
  }
}

export async function readReliability(client: PoolClient): Promise<ReliabilitySettings> {
  const row = (await client.query<{ unreliable_threshold: number; unreliable_redeem_visits: number; unreliable_deposit_percent: number | null }>(
    'SELECT unreliable_threshold, unreliable_redeem_visits, unreliable_deposit_percent FROM accounts',
  )).rows[0]!;
  return { threshold: row.unreliable_threshold, redeemVisits: row.unreliable_redeem_visits, depositPercent: row.unreliable_deposit_percent };
}

export async function readPayment(client: PoolClient): Promise<PaymentSettings> {
  const row = (await client.query<{ blik_phone: string | null; payment_recipient: string | null }>(
    'SELECT blik_phone, payment_recipient FROM accounts',
  )).rows[0];
  return { blikPhone: row?.blik_phone ?? null, recipient: row?.payment_recipient ?? null };
}
