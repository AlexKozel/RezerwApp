import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentSession, Roles, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { SLUG_RE } from '../catalog/catalog.service';
import { NotFoundError } from '../errors';
import { Input } from '../http/validate';
import { LocationsService } from './locations.service';

/**
 * Салоны (D-053). Location, приглашения и подключения: owner. Общий календарь: owner и assistant салона.
 */
@Controller()
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get('locations')
  @UseGuards(SessionGuard)
  @Roles(['owner', 'assistant'])
  list(@CurrentSession() s: Session) {
    return this.locations.list(s.accountId);
  }

  @Post('locations')
  @UseGuards(SessionGuard)
  @Roles(['owner'])
  create(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const location = {
      name: input.string('name', { max: 100 }),
      address: input.optString('address', { max: 300 }) ?? null,
      publicSlug: input.string('publicSlug', { max: 40 }).toLowerCase(),
    };
    input.done();
    return this.locations.create(s.accountId, location);
  }

  @Patch('locations/:id')
  @UseGuards(SessionGuard)
  @Roles(['owner'])
  @HttpCode(204)
  async update(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    const input = new Input(body);
    const raw = (body ?? {}) as Record<string, unknown>;
    const patch = { name: input.optString('name', { max: 100 }), address: raw.address === null ? null : input.optString('address', { max: 300 }) };
    input.done();
    await this.locations.update(s.accountId, id, patch);
  }

  /** Тело: { locationId: uuid | null }. Employee салона работает в этой Location. */
  @Put('staff/:staffId/location')
  @UseGuards(SessionGuard)
  @Roles(['owner'])
  @HttpCode(204)
  async assignStaff(@CurrentSession() s: Session, @Param('staffId', ParseUUIDPipe) staffId: string, @Body() body: unknown): Promise<void> {
    const input = new Input(body);
    const locationId = (body as Record<string, unknown> | null)?.locationId === null ? null : input.uuid('locationId');
    input.done();
    await this.locations.assignStaff(s.accountId, staffId, locationId);
  }

  /** Приглашение Independent-мастера: токен передаётся мастеру любым способом (ссылка, мессенджер). */
  @Post('locations/:id/invites')
  @UseGuards(SessionGuard)
  @Roles(['owner'])
  invite(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    return this.locations.invite(s.accountId, id);
  }

  @Get('locations/:id/calendar')
  @UseGuards(SessionGuard)
  @Roles(['owner', 'assistant'])
  calendar(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const input = new Input(query);
    const from = input.instant('from');
    const to = input.instant('to');
    input.done();
    return this.locations.calendar(s.accountId, id, from, to);
  }

  @Get('memberships')
  @UseGuards(SessionGuard)
  @Roles(['owner'])
  memberships(@CurrentSession() s: Session) {
    return this.locations.memberships(s.accountId);
  }

  /** Мастер (owner своего Account) принимает приглашение салона. Тело: { token }. */
  @Post('memberships/accept')
  @UseGuards(SessionGuard)
  @Roles(['owner'])
  accept(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const token = input.string('token', { max: 200 });
    input.done();
    return this.locations.accept(s.accountId, token);
  }

  @Post('memberships/:id/end')
  @UseGuards(SessionGuard)
  @Roles(['owner'])
  @HttpCode(204)
  async end(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.locations.end(s.accountId, id);
  }

  /** Studio page салона (без входа). */
  @Get('public/locations/:slug')
  publicPage(@Param('slug') slug: string) {
    if (!SLUG_RE.test(slug)) throw new NotFoundError('location');
    return this.locations.publicPage(slug);
  }
}
