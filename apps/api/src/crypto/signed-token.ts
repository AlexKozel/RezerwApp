import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

/**
 * Подписанный токен без хранения в БД: v1.<payload base64url>.<HMAC-SHA256/128 base64url>.
 * Ключ выводится HKDF из мастер-ключа полей (D-042) отдельно для каждого назначения (purpose),
 * поэтому токен одного назначения не подходит для другого. Смена мастер-ключа отзывает все токены.
 */
export class SignedTokens {
  private readonly key: Buffer;

  constructor(masterKey: Buffer, purpose: string) {
    this.key = Buffer.from(hkdfSync('sha256', masterKey, 'rezerwapp', purpose, 32));
  }

  sign(payload: Buffer): string {
    const body = payload.toString('base64url');
    return `v1.${body}.${this.mac(body).toString('base64url')}`;
  }

  /** Полезная нагрузка или null для повреждённого, поддельного или неканонически записанного токена. */
  open(token: string): Buffer | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const [, body, mac] = parts as [string, string, string];
    const given = Buffer.from(mac, 'base64url');
    const payload = Buffer.from(body, 'base64url');
    // Только каноническая запись: декодер игнорирует лишние биты последнего символа, и без этой проверки
    // у одного токена было бы несколько допустимых строк (например, окончание «w» и «x»).
    if (given.toString('base64url') !== mac || payload.toString('base64url') !== body) return null;
    const expected = this.mac(body);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    return payload;
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.key).update(`v1.${body}`).digest().subarray(0, 16);
  }
}

export function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

export function bytesToUuid(bytes: Buffer): string {
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
