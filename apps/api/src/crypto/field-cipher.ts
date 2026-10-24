import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { KeyProvider } from './key-provider';

const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const CACHE_LIMIT = 1000;

/**
 * Шифрование полей на уровне приложения (envelope, D-025): у каждого Account свой ключ данных (DEK),
 * в БД он лежит только обёрнутым мастер-ключом (account_keys). Формат шифротекста:
 * версия (1 байт) | IV (12) | тег GCM (16) | данные. accountId входит в AAD: шифротекст нельзя
 * перенести в строку другого Account.
 *
 * Все методы принимают клиента транзакции withAccount: ключ читается под RLS своего Account.
 */
export class FieldCipher {
  private readonly cache = new Map<string, Buffer>();

  constructor(private readonly keys: KeyProvider) {}

  async encrypt(client: PoolClient, accountId: string, plaintext: string): Promise<Buffer> {
    const key = await this.dataKey(client, accountId);
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(accountId));
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
  }

  async decrypt(client: PoolClient, accountId: string, data: Buffer): Promise<string> {
    if (data[0] !== VERSION) throw new Error('FieldCipher: unknown ciphertext version');
    const key = await this.dataKey(client, accountId);
    const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(1, 1 + IV_LEN));
    decipher.setAAD(Buffer.from(accountId));
    decipher.setAuthTag(data.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN));
    return Buffer.concat([decipher.update(data.subarray(1 + IV_LEN + TAG_LEN)), decipher.final()]).toString('utf8');
  }

  /** Ключ Account: из кэша, из account_keys или создаётся (параллельное создание безопасно: ON CONFLICT). */
  private async dataKey(client: PoolClient, accountId: string): Promise<Buffer> {
    const cached = this.cache.get(accountId);
    if (cached) return cached;

    let row = (await client.query<{ provider: string; wrapped_key: Buffer }>(
      'SELECT provider, wrapped_key FROM account_keys WHERE account_id = $1',
      [accountId],
    )).rows[0];
    if (!row) {
      const wrapped = await this.keys.wrap(randomBytes(32), accountId);
      await client.query(
        'INSERT INTO account_keys (account_id, provider, wrapped_key) VALUES ($1, $2, $3) ON CONFLICT (account_id) DO NOTHING',
        [accountId, this.keys.id, wrapped],
      );
      row = (await client.query<{ provider: string; wrapped_key: Buffer }>(
        'SELECT provider, wrapped_key FROM account_keys WHERE account_id = $1',
        [accountId],
      )).rows[0];
      if (!row) throw new Error('FieldCipher: data key was not stored');
    }
    if (row.provider !== this.keys.id) throw new Error(`FieldCipher: key provider ${row.provider} is not configured`);

    const key = await this.keys.unwrap(row.wrapped_key, accountId);
    if (this.cache.size >= CACHE_LIMIT) this.cache.clear();
    this.cache.set(accountId, key);
    return key;
  }
}
