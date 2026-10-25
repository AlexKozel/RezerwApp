import { randomInt } from 'node:crypto';
import { normalizePhone, type BookingStatus, type DepositMode, type Locale } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import { readPayment } from '../accounts/account-settings.service';
import type { AvailabilityService } from '../availability/availability.service';
import type { BookingsService } from '../bookings/bookings.service';
import type { CatalogService } from '../catalog/catalog.service';
import type { ClientsService } from '../clients/clients.service';
import type { PhoneHasher } from '../crypto/phone-hash';
import type { Db } from '../db/db';
import { AppError, ConflictError, NotFoundError, ValidationError } from '../errors';
import type { RateLimiter } from '../rate-limit';
import type { OtpVerifier } from './otp';

type ConsentType = 'terms' | 'privacy' | 'health';

/** D-044: одновременных заявок pending с одного номера у одного специалиста. */
export const MAX_PENDING_PER_PHONE = 2;

const OTP_REQUESTS_PER_PHONE_HOUR = 5;
const BOOKINGS_PER_IP_HOUR = 10;
const PAYMENT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface PublicBookingInput {
  slug: string;
  serviceId: string;
  variantId: string;
  startsAt: Date;
  name: string;
  phone: string;
  language: Locale;
  otpCode: string;
  acceptTerms: boolean;
  acceptPrivacy: boolean;
  /** Необязательное согласие на обработку данных о здоровье (L-23). */
  acceptHealth?: boolean;
  ip: string;
  now?: Date;
}

export interface PublicBookingResult {
  bookingId: string;
  status: BookingStatus;
  startsAt: Date;
  endsAt: Date;
  holdExpiresAt: Date | null;
  /** Инструкция оплаты (BOOKING_FLOW.md, раздел 4): сумма, код для комментария, номер BLIK и получатель. */
  bookingFee: { amount: number; code: string; method: string; blikPhone: string | null; recipient: string | null } | null;
}

interface ServiceTerms {
  deposit_mode: DepositMode;
  deposit_value: string;
  deposit_scope: 'new_clients' | 'all';
  prepayment_method: 'none' | 'manual_blik' | 'provider_link';
  requires_manual_confirm: boolean;
  price: string;
}

/** Код платежа для комментария к переводу BLIK (BOOKING_FLOW.md, раздел 4): 4 символа без похожих букв и цифр. */
function paymentCode(): string {
  return Array.from({ length: 4 }, () => PAYMENT_CODE_ALPHABET[randomInt(PAYMENT_CODE_ALPHABET.length)]).join('');
}

/**
 * Публичная запись клиента по ссылке специалиста (BOOKING_FLOW.md, раздел 1). Account определяется по slug
 * функцией public_find_staff, дальше всё идёт под RLS этого Account в одной транзакции: клиент, проверки,
 * запись, согласия и запрос оплаты либо сохраняются вместе, либо не сохраняется ничего.
 */
export class PublicBookingService {
  constructor(
    private readonly db: Db,
    private readonly catalog: CatalogService,
    private readonly availability: AvailabilityService,
    private readonly bookings: BookingsService,
    private readonly clients: ClientsService,
    private readonly hasher: PhoneHasher,
    private readonly otp: OtpVerifier,
    private readonly limiter: RateLimiter,
  ) {}

  async resolve(slug: string): Promise<{ accountId: string; staffId: string }> {
    const row = (await this.db.pool.query<{ account_id: string; staff_id: string }>(
      'SELECT account_id, staff_id FROM public_find_staff($1)',
      [slug],
    )).rows[0];
    if (!row) throw new NotFoundError('staff');
    return { accountId: row.account_id, staffId: row.staff_id };
  }

  async profile(slug: string) {
    const { accountId, staffId } = await this.resolve(slug);
    return this.db.withAccount(accountId, async (client) => {
      const staff = (await client.query<{ display_name: string; timezone: string }>(
        'SELECT s.display_name, a.timezone FROM staff s JOIN accounts a ON a.id = s.account_id WHERE s.id = $1',
        [staffId],
      )).rows[0]!;
      return { displayName: staff.display_name, timeZone: staff.timezone, services: await this.catalog.publicCatalog(client, staffId) };
    });
  }

  async slots(slug: string, variantId: string, fromDate: string, toDate: string, now = new Date()): Promise<Date[]> {
    const { accountId, staffId } = await this.resolve(slug);
    return this.availability.slots(accountId, staffId, variantId, fromDate, toDate, now);
  }

  async requestOtp(phoneInput: string, ip: string): Promise<{ alpha: boolean }> {
    const phone = normalizePhone(phoneInput);
    if (!phone) throw new ValidationError({ phone: 'invalid phone number' });
    await this.limiter.hit(`otp:ip:${ip}`, OTP_REQUESTS_PER_PHONE_HOUR * 4, 3600);
    await this.limiter.hit(`otp:phone:${this.hasher.hash(phone).toString('hex')}`, OTP_REQUESTS_PER_PHONE_HOUR, 3600);
    return this.otp.request(phone);
  }

  async book(input: PublicBookingInput): Promise<PublicBookingResult> {
    const now = input.now ?? new Date();
    if (!input.acceptTerms || !input.acceptPrivacy) throw new AppError('CONSENT_REQUIRED', 'Terms and privacy policy must be accepted');
    const phone = normalizePhone(input.phone);
    if (!phone) throw new ValidationError({ phone: 'invalid phone number' });
    await this.limiter.hit(`book:ip:${input.ip}`, BOOKINGS_PER_IP_HOUR, 3600);
    if (!(await this.otp.verify(phone, input.otpCode))) throw new AppError('OTP_INVALID', 'Verification code is incorrect');

    const { accountId, staffId } = await this.resolve(input.slug);

    return this.db.withAccount(accountId, async (client) => {
      const ctx = await this.availability.slotContext(client, staffId, input.variantId);
      const terms = await this.serviceTerms(client, staffId, input.serviceId, input.variantId);
      if (!(await this.availability.isOffered(client, ctx, input.startsAt, now))) {
        throw new ConflictError('SLOT_NOT_AVAILABLE', 'This time is not offered');
      }
      const documents = await this.legalVersions(client, input.language, input.acceptHealth ?? false);

      const person = await this.clients.findOrCreate(client, accountId, { phone, name: input.name, language: input.language });
      // Блокировка карточки клиента сериализует его параллельные заявки, иначе лимит D-044 обходится гонкой.
      await client.query('SELECT 1 FROM clients WHERE id = $1 FOR UPDATE', [person.id]);
      const pending = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM bookings
          WHERE client_id = $1 AND staff_id = $2 AND status = 'pending' AND hold_expires_at > now()`,
        [person.id, staffId],
      );
      if (pending.rows[0]!.n >= MAX_PENDING_PER_PHONE) throw new ConflictError('PENDING_LIMIT', 'Too many unconfirmed bookings');

      // D-016: доверенный клиент = есть завершённый визит у этого специалиста.
      const trusted = (await client.query(
        "SELECT 1 FROM bookings WHERE client_id = $1 AND staff_id = $2 AND status = 'completed' LIMIT 1",
        [person.id, staffId],
      )).rowCount! > 0;
      const feeRequired = terms.deposit_mode !== 'none' && (terms.deposit_scope === 'all' || !trusted);
      // D-016 и D-045: сразу confirmed только без оплаты и если клиент доверенный или мастер не требует ручного подтверждения.
      const confirmNow = !feeRequired && (trusted || !terms.requires_manual_confirm);

      const booking = await this.bookings.createIn(client, {
        accountId,
        staffId,
        clientId: person.id,
        serviceId: input.serviceId,
        variantId: input.variantId,
        startsAt: input.startsAt,
        requiresApproval: !confirmNow,
        actor: 'client',
      });

      for (const [type, version] of documents) {
        await client.query('INSERT INTO consents (account_id, client_id, type, text_version) VALUES ($1, $2, $3, $4)', [
          accountId,
          person.id,
          type,
          version,
        ]);
      }

      const bookingFee = feeRequired ? await this.createPaymentRequest(client, accountId, booking.id, terms) : null;
      return {
        bookingId: booking.id,
        status: booking.status,
        startsAt: booking.startsAt,
        endsAt: booking.endsAt,
        holdExpiresAt: booking.holdExpiresAt,
        bookingFee,
      };
    });
  }

  private async serviceTerms(client: PoolClient, staffId: string, serviceId: string, variantId: string): Promise<ServiceTerms> {
    const row = (await client.query<ServiceTerms>(
      `SELECT s.deposit_mode, s.deposit_value, s.deposit_scope, s.prepayment_method, s.requires_manual_confirm,
              COALESCE(ss.override_price, v.price) AS price
         FROM services s
         JOIN service_variants v ON v.service_id = s.id AND v.id = $3
         JOIN staff_services ss ON ss.service_id = s.id AND ss.staff_id = $1
        WHERE s.id = $2 AND s.active AND v.active`,
      [staffId, serviceId, variantId],
    )).rows[0];
    if (!row) throw new NotFoundError('service variant for this staff member');
    return row;
  }

  /**
   * Актуальные версии принятых клиентом текстов на его языке (иначе польская, D-036): Regulamin и политика
   * всегда, согласие на данные о здоровье только если клиент его отметил (L-23, чекбокс не отмечен по умолчанию).
   */
  private async legalVersions(client: PoolClient, language: Locale, withHealth: boolean): Promise<Array<[ConsentType, string]>> {
    const types: ConsentType[] = withHealth ? ['terms', 'privacy', 'health'] : ['terms', 'privacy'];
    const rows = await client.query<{ type: ConsentType; version: string }>(
      `SELECT DISTINCT ON (type) type, version FROM consent_documents
        WHERE type = ANY($2) AND language IN ($1, 'pl') AND valid_from <= now()
        ORDER BY type, (language = $1) DESC, valid_from DESC`,
      [language, types],
    );
    if (rows.rows.length < types.length) throw new AppError('LEGAL_TEXTS_MISSING', 'A required legal text is not published');
    return rows.rows.map((r) => [r.type, r.version]);
  }

  /**
   * Запрос резервационной оплаты (manual_blik, D-010). Сумма не выше 50% фактической цены (D-014):
   * персональная цена специалиста может быть ниже цены варианта, по которой проверялся каталог.
   */
  private async createPaymentRequest(client: PoolClient, accountId: string, bookingId: string, terms: ServiceTerms) {
    const price = Number(terms.price);
    const raw = terms.deposit_mode === 'percent' ? (price * Number(terms.deposit_value)) / 100 : Number(terms.deposit_value);
    const amount = Math.round(Math.min(raw, price / 2) * 100) / 100;
    if (amount <= 0) return null;
    const mode = terms.prepayment_method === 'provider_link' ? 'provider_link' : 'manual_blik';
    const payment = await readPayment(client);
    // Каталог не даёт сохранить такую услугу без номера (D-048), но номер могли стереть напрямую в БД.
    if (mode === 'manual_blik' && !payment.blikPhone) throw new ConflictError('PAYMENT_NOT_CONFIGURED', 'BLIK phone is not set');
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const code = paymentCode();
      const inserted = await client.query(
        `INSERT INTO payment_requests (account_id, booking_id, mode, amount, code) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account_id, code) DO NOTHING`,
        [accountId, bookingId, mode, amount, code],
      );
      if (inserted.rowCount === 1) return { amount, code, method: mode, blikPhone: payment.blikPhone, recipient: payment.recipient };
    }
    throw new Error('could not allocate a unique payment code');
  }
}
