import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { BOOKING_STATUSES, LOCALES } from '@rezerwapp/shared';
import { StaffAccess } from '../auth/access';
import { CurrentSession, Roles, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { Input } from '../http/validate';
import { BookingsService } from './bookings.service';
import { ManualBookingService } from './manual-booking.service';

/**
 * Календарь и заявки мастера: список за период, одобрение, отклонение, завершение и т.д.
 * owner и assistant видят записи всех специалистов, staff только свои.
 */
@Controller('bookings')
@UseGuards(SessionGuard)
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly access: StaffAccess,
    private readonly manual: ManualBookingService,
  ) {}

  /**
   * Ручная запись (любая роль; staff только к себе). Тело: { staffId, serviceId, variantId, startsAt,
   * clientId } или вместо clientId { client: { name, phone, language? } }.
   */
  @Post()
  async create(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const staffId = input.uuid('staffId');
    const serviceId = input.uuid('serviceId');
    const variantId = input.uuid('variantId');
    const startsAt = input.instant('startsAt');
    const clientId = input.optUuid('clientId');
    let client: { name: string; phone: string; language: (typeof LOCALES)[number] } | undefined;
    if (!clientId) {
      const c = new Input((body as Record<string, unknown> | null)?.client);
      client = { name: c.string('name', { max: 100 }), phone: c.string('phone', { max: 30 }), language: c.optOneOf('language', LOCALES) ?? 'pl' };
      c.done();
    }
    input.done();
    await this.access.assertStaff(s, staffId);
    return this.manual.create({ accountId: s.accountId, staffId, serviceId, variantId, startsAt, clientId, client });
  }

  @Get()
  async list(@CurrentSession() s: Session, @Query() query: unknown) {
    const input = new Input(query);
    const from = input.instant('from');
    const to = input.instant('to');
    const staffId = input.optUuid('staffId');
    input.done();
    const scope = await this.access.scope(s);
    if (scope === null) return this.bookings.list(s.accountId, from, to, staffId);
    // staff: только свои записи, даже если staffId не указан или указан чужой.
    const own = staffId ? scope.filter((id) => id === staffId) : scope;
    const lists = await Promise.all(own.map((id) => this.bookings.list(s.accountId, from, to, id)));
    return lists.flat().sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }

  /** Тело: { to: "confirmed", expectedVersion?: 1 }. */
  @Post(':id/transition')
  async transition(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = new Input(body);
    const to = input.oneOf('to', BOOKING_STATUSES);
    const expectedVersion = input.optInt('expectedVersion', { min: 1, max: 1_000_000 });
    input.done();
    await this.access.assertBooking(s, id);
    return this.bookings.transition({ accountId: s.accountId, bookingId: id, to, actor: 'master', expectedVersion });
  }

  /** Оплаты к возврату или проверке (D-072); staff только по своим записям. */
  @Get('payments-due')
  async paymentsDue(@CurrentSession() s: Session) {
    const scope = await this.access.scope(s);
    if (!scope) return this.bookings.paymentsDue(s.accountId);
    const lists = await Promise.all(scope.map((id) => this.bookings.paymentsDue(s.accountId, id)));
    return lists.flat().sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }

  /** Мастер закрыл вопрос с оплатой (D-072). Тело: { result: "refunded" | "not_received" }. */
  @Post(':id/payment')
  @Roles(['owner', 'staff'])
  @HttpCode(204)
  async settlePayment(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    const input = new Input(body);
    const result = input.oneOf('result', ['refunded', 'not_received'] as const);
    input.done();
    await this.access.assertBooking(s, id);
    await this.bookings.settlePayment(s.accountId, id, result);
  }

  /** Разовые затраты на визит (D-071). Тело: { amount: number | null }; только если Account их учитывает. */
  @Post(':id/extra-cost')
  @Roles(['owner', 'staff'])
  @HttpCode(204)
  async extraCost(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    const input = new Input(body);
    const raw = (body ?? {}) as Record<string, unknown>;
    const amount = raw.amount === null ? null : input.money('amount', { max: 100_000 });
    input.done();
    await this.access.assertBooking(s, id);
    await this.bookings.setExtraCost(s.accountId, id, amount);
  }

  /** Уважительная причина неявки или поздней отмены (D-066). Тело: { excused: true | false }. */
  @Post(':id/excuse')
  @Roles(['owner', 'staff'])
  @HttpCode(204)
  async excuse(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    const input = new Input(body);
    const excused = input.bool('excused');
    input.done();
    await this.access.assertBooking(s, id);
    await this.bookings.excuse(s.accountId, id, excused);
  }
}
