import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { BOOKING_STATUSES } from '@rezerwapp/shared';
import { CurrentSession, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { Input } from '../http/validate';
import { BookingsService } from './bookings.service';

/** Календарь и заявки мастера: список за период, одобрение, отклонение, завершение и т.д. */
@Controller('bookings')
@UseGuards(SessionGuard)
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Get()
  list(@CurrentSession() s: Session, @Query() query: unknown) {
    const input = new Input(query);
    const from = input.instant('from');
    const to = input.instant('to');
    const staffId = input.optUuid('staffId');
    input.done();
    return this.bookings.list(s.accountId, from, to, staffId);
  }

  /** Тело: { to: "confirmed", expectedVersion?: 1 }. */
  @Post(':id/transition')
  transition(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = new Input(body);
    const to = input.oneOf('to', BOOKING_STATUSES);
    const expectedVersion = input.optInt('expectedVersion', { min: 1, max: 1_000_000 });
    input.done();
    return this.bookings.transition({ accountId: s.accountId, bookingId: id, to, actor: 'master', expectedVersion });
  }
}
