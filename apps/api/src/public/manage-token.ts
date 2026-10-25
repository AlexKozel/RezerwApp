import { SignedTokens, bytesToUuid, uuidToBytes } from '../crypto/signed-token';

/**
 * Ссылка управления записью для клиента без регистрации (BOOKING_FLOW.md, раздел 5): подписанный токен
 * с Account и записью (D-051). По токену сразу известен Account, дальше всё идёт под RLS.
 * Срока у токена нет: что можно сделать, решают статус записи и политика (дедлайн, лимит переносов).
 */
export class ManageTokens {
  private readonly tokens: SignedTokens;

  constructor(masterKey: Buffer) {
    this.tokens = new SignedTokens(masterKey, 'manage-link-v1');
  }

  issue(accountId: string, bookingId: string): string {
    return this.tokens.sign(Buffer.concat([uuidToBytes(accountId), uuidToBytes(bookingId)]));
  }

  /** null для любого повреждённого или поддельного токена. */
  verify(token: string): { accountId: string; bookingId: string } | null {
    const payload = this.tokens.open(token);
    if (!payload || payload.length !== 32) return null;
    return { accountId: bytesToUuid(payload.subarray(0, 16)), bookingId: bytesToUuid(payload.subarray(16)) };
  }
}
