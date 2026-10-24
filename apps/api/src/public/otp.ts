import { timingSafeEqual } from 'node:crypto';

/**
 * Подтверждение номера клиента (D-035). Реальная отправка SMS появится вместе с провайдером; интерфейс
 * не меняется. В alpha код тестовый и одинаковый для всех, антиспам держится на лимитах частоты.
 */
export interface OtpVerifier {
  request(phoneE164: string): Promise<{ alpha: boolean }>;
  verify(phoneE164: string, code: string): Promise<boolean>;
}

export class AlphaOtpVerifier implements OtpVerifier {
  constructor(private readonly code: string) {}

  async request(): Promise<{ alpha: boolean }> {
    return { alpha: true };
  }

  async verify(_phoneE164: string, code: string): Promise<boolean> {
    const a = Buffer.from(code);
    const b = Buffer.from(this.code);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
