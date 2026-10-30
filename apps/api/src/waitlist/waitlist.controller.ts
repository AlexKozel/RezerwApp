import { Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { StaffAccess } from '../auth/access';
import { CurrentSession, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { Input } from '../http/validate';
import { WaitlistService } from './waitlist.service';

/** Лист ожидания для мастера (D-068): owner и assistant видят очереди всех специалистов, staff только свою. */
@Controller('waitlist')
@UseGuards(SessionGuard)
export class WaitlistController {
  constructor(
    private readonly waitlist: WaitlistService,
    private readonly access: StaffAccess,
  ) {}

  @Get()
  async list(@CurrentSession() s: Session, @Query() query: unknown) {
    const input = new Input(query);
    const staffId = input.optUuid('staffId');
    input.done();
    const scope = await this.access.scope(s);
    const staffIds = scope ? (staffId ? scope.filter((id) => id === staffId) : scope) : staffId ? [staffId] : null;
    return this.waitlist.list(s.accountId, staffIds);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.waitlist.remove(s.accountId, id, await this.access.scope(s));
  }
}
