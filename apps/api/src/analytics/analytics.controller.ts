import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { StaffAccess } from '../auth/access';
import { CurrentSession, Roles, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { Input } from '../http/validate';
import { AnalyticsService } from './analytics.service';

/** «Сколько вы сэкономили» и маржа (D-056). owner видит весь Account, staff только свои записи; assistant нет. */
@Controller('analytics')
@UseGuards(SessionGuard)
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly access: StaffAccess,
  ) {}

  /** ?from&to (моменты ISO), ?commissionPercent=0..50 для условного сравнения с маркетплейсом. */
  @Get('summary')
  @Roles(['owner', 'staff'])
  async summary(@CurrentSession() s: Session, @Query() query: unknown) {
    const input = new Input(query);
    const from = input.instant('from');
    const to = input.instant('to');
    const commissionPercent = input.optInt('commissionPercent', { min: 0, max: 50 }) ?? null;
    input.done();
    return this.analytics.summary(s.accountId, await this.access.scope(s), from, to, commissionPercent);
  }
}
