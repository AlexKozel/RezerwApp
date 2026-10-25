import type { Locale } from '@rezerwapp/shared';
import type { ClientsService } from '../clients/clients.service';
import type { Db } from '../db/db';
import { NotFoundError, ValidationError } from '../errors';
import { notifySafely, type Notifier } from '../jobs/notifier';
import type { Booking, BookingsService } from './bookings.service';

export interface ManualBookingInput {
  accountId: string;
  staffId: string;
  serviceId: string;
  variantId: string;
  startsAt: Date;
  /** Существующий клиент Account или новый по имени и телефону (поиск по HMAC, как при публичной записи). */
  clientId?: string;
  client?: { name: string; phone: string; language: Locale };
}

/**
 * Ручная запись мастером (MVP: клиент позвонил или написал в мессенджер). Сразу confirmed, без OTP и без
 * резервационной оплаты: мастер договорился с клиентом сам. Рабочие часы не проверяются (это решение мастера),
 * пересечение с другой записью по-прежнему запрещает ограничение БД (D-031). Клиенту уходит подтверждение
 * со ссылкой управления (D-052).
 */
export class ManualBookingService {
  constructor(
    private readonly db: Db,
    private readonly bookings: BookingsService,
    private readonly clients: ClientsService,
    private readonly notifier?: Notifier,
  ) {}

  async create(input: ManualBookingInput): Promise<Booking> {
    if (!input.clientId && !input.client) throw new ValidationError({ client: 'clientId or client is required' });
    const booking = await this.db.withAccount(input.accountId, async (client) => {
      let clientId = input.clientId;
      if (clientId) {
        const found = await client.query('SELECT 1 FROM clients WHERE id = $1 AND anonymized_at IS NULL', [clientId]);
        if (found.rowCount === 0) throw new NotFoundError('client');
      } else {
        clientId = (await this.clients.findOrCreate(client, input.accountId, input.client!)).id;
      }
      return this.bookings.createIn(client, {
        accountId: input.accountId,
        staffId: input.staffId,
        clientId,
        serviceId: input.serviceId,
        variantId: input.variantId,
        startsAt: input.startsAt,
        requiresApproval: false,
        actor: 'master',
      });
    });
    await notifySafely(this.notifier, { type: 'booking.created', accountId: input.accountId, bookingId: booking.id, status: booking.status });
    return booking;
  }
}
