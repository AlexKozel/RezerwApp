import type { Locale } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import type { FieldCipher } from '../crypto/field-cipher';
import type { PhoneHasher } from '../crypto/phone-hash';
import { ValidationError } from '../errors';

export interface ClientRef {
  id: string;
  created: boolean;
}

/**
 * Клиентская база Account (D-020, D-023). Телефон хранится зашифрованным (phone_encrypted), поиск идёт по
 * HMAC (phone_hash); номер в открытом виде в БД не попадает. Методы работают в транзакции withAccount.
 */
export class ClientsService {
  constructor(
    private readonly hasher: PhoneHasher,
    private readonly cipher: FieldCipher,
  ) {}

  /**
   * Находит клиента по телефону или создаёт. Имя и язык существующего клиента не перезаписываются:
   * запись с чужого устройства не должна менять карточку, которую ведёт мастер.
   */
  async findOrCreate(
    client: PoolClient,
    accountId: string,
    input: { phone: string; name: string; language: Locale },
  ): Promise<ClientRef> {
    const phone = this.hasher.hashInput(input.phone);
    if (!phone) throw new ValidationError({ phone: 'invalid phone number' });

    const existing = await client.query<{ id: string }>('SELECT id FROM clients WHERE phone_hash = $1', [phone.hash]);
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

    const encrypted = await this.cipher.encrypt(client, accountId, phone.e164);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO clients (account_id, name, phone_encrypted, phone_hash, language)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (account_id, phone_hash) DO NOTHING
       RETURNING id`,
      [accountId, input.name, encrypted, phone.hash, input.language],
    );
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };

    // Параллельная запись с того же номера успела создать клиента.
    const raced = await client.query<{ id: string }>('SELECT id FROM clients WHERE phone_hash = $1', [phone.hash]);
    if (!raced.rows[0]) throw new Error('client insert conflicted but row is not visible');
    return { id: raced.rows[0].id, created: false };
  }

  /** Телефон клиента в E.164 для мастера (карточка клиента, звонок). */
  async phoneOf(client: PoolClient, accountId: string, clientId: string): Promise<string | null> {
    const row = (await client.query<{ phone_encrypted: Buffer }>('SELECT phone_encrypted FROM clients WHERE id = $1', [clientId])).rows[0];
    return row ? this.cipher.decrypt(client, accountId, row.phone_encrypted) : null;
  }
}
