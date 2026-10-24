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
}

export async function readPayment(client: PoolClient): Promise<PaymentSettings> {
  const row = (await client.query<{ blik_phone: string | null; payment_recipient: string | null }>(
    'SELECT blik_phone, payment_recipient FROM accounts',
  )).rows[0];
  return { blikPhone: row?.blik_phone ?? null, recipient: row?.payment_recipient ?? null };
}
