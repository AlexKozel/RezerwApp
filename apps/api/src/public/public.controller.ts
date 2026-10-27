import { Body, Controller, Get, HttpCode, Ip, Param, Post, Query } from '@nestjs/common';
import { LOCALES } from '@rezerwapp/shared';
import { SLUG_RE } from '../catalog/catalog.service';
import { NotFoundError } from '../errors';
import { Input } from '../http/validate';
import { ManageBookingService } from './manage-booking.service';
import { PublicBookingService } from './public-booking.service';

function slugOf(raw: string): string {
  if (!SLUG_RE.test(raw)) throw new NotFoundError('staff');
  return raw;
}

/** Публичная страница записи по ссылке специалиста (link-in-bio). Без входа; Account определяется по slug. */
@Controller('public')
export class PublicController {
  constructor(
    private readonly booking: PublicBookingService,
    private readonly manageBooking: ManageBookingService,
  ) {}

  @Get('staff/:slug')
  profile(@Param('slug') slug: string) {
    return this.booking.profile(slugOf(slug));
  }

  @Get('staff/:slug/slots')
  async slots(@Param('slug') slug: string, @Query() query: unknown) {
    const input = new Input(query);
    const variantId = input.uuid('variantId');
    const from = input.date('from');
    const to = input.date('to');
    input.done();
    return { slots: await this.booking.slots(slugOf(slug), variantId, from, to) };
  }

  @Post('otp')
  @HttpCode(200)
  requestOtp(@Body() body: unknown, @Ip() ip: string) {
    const input = new Input(body);
    const phone = input.string('phone', { max: 30 });
    input.done();
    return this.booking.requestOtp(phone, ip);
  }

  @Post('staff/:slug/bookings')
  book(@Param('slug') slug: string, @Body() body: unknown, @Ip() ip: string) {
    const input = new Input(body);
    const request = {
      slug: slugOf(slug),
      serviceId: input.uuid('serviceId'),
      variantId: input.uuid('variantId'),
      startsAt: input.instant('startsAt'),
      name: input.string('name', { max: 100 }),
      phone: input.string('phone', { max: 30 }),
      language: input.optOneOf('language', LOCALES) ?? 'pl',
      otpCode: input.string('otpCode', { max: 8 }),
      acceptTerms: input.bool('acceptTerms'),
      acceptPrivacy: input.bool('acceptPrivacy'),
      acceptHealth: input.optBool('acceptHealth') ?? false,
      acceptDeposit: input.optBool('acceptDeposit') ?? false,
      ip,
    };
    input.done();
    return this.booking.book(request);
  }

  // --- Управление записью по ссылке (BOOKING_FLOW.md, раздел 5). Токен проверяется подписью, неверный = 404. ---

  @Get('bookings/:token')
  manage(@Param('token') token: string, @Ip() ip: string) {
    return this.manageBooking.view(token, ip);
  }

  @Get('bookings/:token/slots')
  async manageSlots(@Param('token') token: string, @Query() query: unknown, @Ip() ip: string) {
    const input = new Input(query);
    const from = input.date('from');
    const to = input.date('to');
    input.done();
    return { slots: await this.manageBooking.slots(token, ip, from, to) };
  }

  @Post('bookings/:token/cancel')
  @HttpCode(200)
  cancel(@Param('token') token: string, @Ip() ip: string) {
    return this.manageBooking.cancel(token, ip);
  }

  /** Тело: { startsAt }. Ответ содержит токен новой записи: старая ссылка показывает статус rescheduled. */
  @Post('bookings/:token/reschedule')
  @HttpCode(200)
  reschedule(@Param('token') token: string, @Body() body: unknown, @Ip() ip: string) {
    const input = new Input(body);
    const startsAt = input.instant('startsAt');
    input.done();
    return this.manageBooking.reschedule(token, ip, startsAt);
  }
}
