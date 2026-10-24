import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentSession, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { Input } from '../http/validate';
import { AvailabilityService } from './availability.service';

/** График, выходные и блоки времени специалиста (D-043), предпросмотр слотов для мастера. */
@Controller('staff/:staffId')
@UseGuards(SessionGuard)
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('settings')
  settings(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.availability.getSettings(s.accountId, staffId);
  }

  @Patch('settings')
  updateSettings(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Body() body: unknown) {
    const input = new Input(body);
    const patch = {
      slotStepMin: input.optInt('slotStepMin', { min: 5, max: 240 }),
      bookingHorizonDays: input.optInt('bookingHorizonDays', { min: 1, max: 365 }),
      minLeadMinutes: input.optInt('minLeadMinutes', { min: 0, max: 10080 }),
    };
    input.done();
    return this.availability.updateSettings(s.accountId, staffId, patch);
  }

  @Get('working-hours')
  workingHours(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string) {
    return this.availability.getWorkingHours(s.accountId, staffId);
  }

  /** Тело: { intervals: [{ weekday: 1, start: "09:00", end: "18:00" }] }. День без интервалов = выходной. */
  @Put('working-hours')
  @HttpCode(204)
  async setWorkingHours(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Body() body: unknown): Promise<void> {
    const input = new Input(body);
    const intervals = input.list('intervals', { max: 70 }).map((i) => ({
      weekday: i.int('weekday', { min: 0, max: 6 }),
      start: i.timeOfDay('start'),
      end: i.timeOfDay('end'),
    }));
    input.done();
    await this.availability.setWorkingHours(s.accountId, staffId, intervals);
  }

  /** Разовый выходной на всю местную дату. */
  @Post('days-off')
  addDayOff(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Body() body: unknown) {
    const input = new Input(body);
    const date = input.date('date');
    const reason = input.optString('reason', { max: 200 }) ?? null;
    input.done();
    return this.availability.addDayOff(s.accountId, staffId, date, reason);
  }

  @Post('time-blocks')
  addTimeBlock(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Body() body: unknown) {
    const input = new Input(body);
    const start = input.instant('start');
    const end = input.instant('end');
    const reason = input.optString('reason', { max: 200 }) ?? null;
    input.done();
    return this.availability.addTimeBlock(s.accountId, staffId, start, end, reason);
  }

  @Get('time-blocks')
  listTimeBlocks(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Query() query: unknown) {
    const input = new Input(query);
    const from = input.instant('from');
    const to = input.instant('to');
    input.done();
    return this.availability.listTimeBlocks(s.accountId, staffId, from, to);
  }

  @Delete('time-blocks/:blockId')
  @HttpCode(204)
  async removeTimeBlock(
    @CurrentSession() s: Session,
    @Param('staffId', ParseUUIDPipe) staffId: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
  ): Promise<void> {
    await this.availability.removeTimeBlock(s.accountId, staffId, blockId);
  }

  @Get('slots')
  async slots(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Query() query: unknown) {
    const input = new Input(query);
    const variantId = input.uuid('variantId');
    const from = input.date('from');
    const to = input.date('to');
    input.done();
    return { slots: await this.availability.slots(s.accountId, staffId, variantId, from, to) };
  }
}
