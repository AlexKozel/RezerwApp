import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Обёртка ключей данных Account мастер-ключом (D-042). Сейчас мастер-ключ из окружения; после выбора
 * хостинга появится реализация через KMS с тем же интерфейсом, схема БД не меняется.
 * accountId участвует как связанные данные (AAD): обёрнутый ключ одного Account нельзя подставить другому.
 */
export interface KeyProvider {
  /** Записывается в account_keys.provider, чтобы при смене провайдера знать, чем разворачивать ключ. */
  readonly id: string;
  wrap(dataKey: Buffer, accountId: string): Promise<Buffer>;
  unwrap(wrapped: Buffer, accountId: string): Promise<Buffer>;
}

const IV_LEN = 12;
const TAG_LEN = 16;

export class EnvKeyProvider implements KeyProvider {
  readonly id = 'env-v1';

  constructor(private readonly masterKey: Buffer) {
    if (masterKey.length !== 32) throw new Error('EnvKeyProvider: master key must be 32 bytes');
  }

  async wrap(dataKey: Buffer, accountId: string): Promise<Buffer> {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    cipher.setAAD(Buffer.from(`dek:${accountId}`));
    const body = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  async unwrap(wrapped: Buffer, accountId: string): Promise<Buffer> {
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, wrapped.subarray(0, IV_LEN));
    decipher.setAAD(Buffer.from(`dek:${accountId}`));
    decipher.setAuthTag(wrapped.subarray(IV_LEN, IV_LEN + TAG_LEN));
    return Buffer.concat([decipher.update(wrapped.subarray(IV_LEN + TAG_LEN)), decipher.final()]);
  }
}
