import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { StaffAccess } from '../auth/access';
import { CurrentSession, Roles, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { Input } from '../http/validate';
import { AvailabilityService } from './availability.service';

/**
 * График, выходные и блоки времени специалиста (D-043), предпросмотр слотов для мастера.
 * owner и assistant ведут расписание всех специалистов, staff только своё (StaffAccess).
 */
@Controller('staff/:staffId')
@UseGuards(SessionGuard)
export class AvailabilityController {
  constructor(
    private readonly availability: AvailabilityService,
    private readonly access: StaffAccess,
  ) {}

  @Get('settings')
  async settings(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string) {
    await this.access.assertStaff(s, staffId);
    return this.availability.getSettings(s.accountId, staffId);
  }

  /** Шаг слотов, горизонт и минимальное время до записи меняют owner и сам специалист. */
  @Patch('settings')
  @Roles(['owner', 'staff'])
  async updateSettings(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Body() body: unknown) {
    const input = new Input(body);
    const patch = {
      slotStepMin: input.optInt('slotStepMin', { min: 5, max: 240 }),
      bookingHorizonDays: input.optInt('bookingHorizonDays', { min: 1, max: 365 }),
      minLeadMinutes: input.optInt('minLeadMinutes', { min: 0, max: 10080 }),
    };
    input.done();
    await this.access.assertStaff(s, staffId);
    return this.availability.updateSettings(s.accountId, staffId, patch);
  }

  @Get('working-hours')
  async workingHours(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string) {
    await this.access.assertStaff(s, staffId);
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
    await this.access.assertStaff(s, staffId);
    await this.availability.setWorkingHours(s.accountId, staffId, intervals);
  }

  /** Разовый выходной на всю местную дату. */
  @Post('days-off')
  async addDayOff(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Body() body: unknown) {
    const input = new Input(body);
    const date = input.date('date');
    const reason = input.optString('reason', { max: 200 }) ?? null;
    input.done();
    await this.access.assertStaff(s, staffId);
    return this.availability.addDayOff(s.accountId, staffId, date, reason);
  }

  @Post('time-blocks')
  async addTimeBlock(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Body() body: unknown) {
    const input = new Input(body);
    const start = input.instant('start');
    const end = input.instant('end');
    const reason = input.optString('reason', { max: 200 }) ?? null;
    input.done();
    await this.access.assertStaff(s, staffId);
    return this.availability.addTimeBlock(s.accountId, staffId, start, end, reason);
  }

  @Get('time-blocks')
  async listTimeBlocks(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Query() query: unknown) {
    const input = new Input(query);
    const from = input.instant('from');
    const to = input.instant('to');
    input.done();
    await this.access.assertStaff(s, staffId);
    return this.availability.listTimeBlocks(s.accountId, staffId, from, to);
  }

  @Delete('time-blocks/:blockId')
  @HttpCode(204)
  async removeTimeBlock(
    @CurrentSession() s: Session,
    @Param('staffId', ParseUUIDPipe) staffId: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
  ): Promise<void> {
    await this.access.assertStaff(s, staffId);
    await this.availability.removeTimeBlock(s.accountId, staffId, blockId);
  }

  @Get('slots')
  async slots(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Query() query: unknown) {
    const input = new Input(query);
    const variantId = input.uuid('variantId');
    const from = input.date('from');
    const to = input.date('to');
    input.done();
    await this.access.assertStaff(s, staffId);
    return { slots: await this.availability.slots(s.accountId, staffId, variantId, from, to) };
  }
}
