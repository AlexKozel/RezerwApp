import { createHmac } from 'node:crypto';
import { normalizePhone } from '@rezerwapp/shared';

/**
 * HMAC-SHA256 нормализованного (E.164) номера с секретом PHONE_HASH_PEPPER. Используется для поиска клиента
 * и blacklist внутри Account без хранения номера в открытом виде (DATA_MODEL.md, D-042).
 * Без pepper хеш короткого номера перебирается за минуты, поэтому секрет обязателен.
 */
export class PhoneHasher {
  constructor(private readonly pepper: string) {
    if (pepper === '') throw new Error('PhoneHasher: pepper is empty');
  }

  /** Номер уже в E.164. */
  hash(e164: string): Buffer {
    return createHmac('sha256', this.pepper).update(e164, 'utf8').digest();
  }

  /** Нормализует ввод и хеширует. null, если номер некорректен. */
  hashInput(raw: string): { e164: string; hash: Buffer } | null {
    const e164 = normalizePhone(raw);
    return e164 === null ? null : { e164, hash: this.hash(e164) };
  }
}
