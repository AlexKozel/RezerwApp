import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

const UUID_HEX = /^[0-9a-f]{32}$/;

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * Ссылка управления записью для клиента без регистрации (BOOKING_FLOW.md, раздел 5): v1.<account+booking>.<HMAC>.
 * Подпись HMAC-SHA256 (128 бит) ключом, выведенным из мастер-ключа через HKDF, поэтому отдельный секрет не нужен
 * и токен не хранится в БД. По токену сразу известен Account, дальше всё идёт под RLS.
 * Срока у токена нет: что можно сделать, решают статус записи и политика (дедлайн, лимит переносов).
 * Смена мастер-ключа делает старые ссылки недействительными.
 */
export class ManageTokens {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    this.key = Buffer.from(hkdfSync('sha256', masterKey, 'rezerwapp', 'manage-link-v1', 32));
  }

  issue(accountId: string, bookingId: string): string {
    const payload = Buffer.concat([uuidToBytes(accountId), uuidToBytes(bookingId)]).toString('base64url');
    return `v1.${payload}.${this.mac(payload).toString('base64url')}`;
  }

  /** null для любого повреждённого или поддельного токена. */
  verify(token: string): { accountId: string; bookingId: string } | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const [, payload, mac] = parts as [string, string, string];
    const expected = this.mac(payload);
    const given = Buffer.from(mac, 'base64url');
    const bytes = Buffer.from(payload, 'base64url');
    // Только каноническая запись: декодер игнорирует лишние биты последнего символа, и без этой проверки
    // у одного токена было бы несколько допустимых строк (например, окончание «w» и «x»).
    if (given.toString('base64url') !== mac || bytes.toString('base64url') !== payload) return null;
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    if (bytes.length !== 32) return null;
    const [a, b] = [bytes.subarray(0, 16), bytes.subarray(16)];
    if (!UUID_HEX.test(a.toString('hex')) || !UUID_HEX.test(b.toString('hex'))) return null;
    return { accountId: bytesToUuid(a), bookingId: bytesToUuid(b) };
  }

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.key).update(`v1.${payload}`).digest().subarray(0, 16);
  }
}
