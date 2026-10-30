import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { CurrentSession, Roles, SessionGuard, SkipAcceptance } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { UsersService } from '../auth/users.service';
import { Input } from '../http/validate';
import { AccountSettingsService } from './account-settings.service';

const ROLES = ['owner', 'staff', 'assistant'] as const;

/** Пользователи Account и реквизиты оплаты: только owner. Смена своего пароля: любой пользователь. */
@Controller()
@UseGuards(SessionGuard)
export class AccountController {
  constructor(
    private readonly users: UsersService,
    private readonly settings: AccountSettingsService,
  ) {}

  @Get('users')
  @Roles(['owner'])
  listUsers(@CurrentSession() s: Session) {
    return this.users.list(s.accountId);
  }

  /** Тело: { email, role, password, staffId? }. Owner передаёт начальный пароль сотруднику сам. */
  @Post('users')
  @Roles(['owner'])
  createUser(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const user = {
      email: input.string('email', { max: 254 }),
      role: input.oneOf('role', ROLES),
      password: input.string('password', { max: 1000 }),
      staffId: input.optUuid('staffId') ?? null,
    };
    input.done();
    return this.users.create(s.accountId, user);
  }

  /** Тело: { role?, staffId? }; staffId: null отвязывает от специалиста. */
  @Patch('users/:id')
  @Roles(['owner'])
  updateUser(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = new Input(body);
    const role = input.optOneOf('role', ROLES);
    const raw = (body as Record<string, unknown> | null)?.staffId;
    const staffId = raw === null ? null : input.optUuid('staffId');
    input.done();
    return this.users.update(s.accountId, id, { role, staffId });
  }

  /** Сброс пароля сотрудника. Тело: { password } (временный, сотрудник сменит его при входе). */
  @Post('users/:id/reset-password')
  @Roles(['owner'])
  @HttpCode(204)
  async resetPassword(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    const input = new Input(body);
    const password = input.string('password', { max: 1000 });
    input.done();
    await this.users.resetPassword(s.accountId, s.userId, id, password);
  }

  @Delete('users/:id')
  @Roles(['owner'])
  @HttpCode(204)
  async removeUser(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.users.remove(s.accountId, id);
  }

  @Post('auth/password')
  @SkipAcceptance(true)
  @HttpCode(204)
  async changePassword(@CurrentSession() s: Session, @Body() body: unknown): Promise<void> {
    const input = new Input(body);
    const current = input.string('currentPassword', { max: 1000 });
    const next = input.string('newPassword', { max: 1000 });
    input.done();
    await this.users.changePassword(s.accountId, s.userId, current, next);
  }

  @Get('account/payment')
  @Roles(['owner'])
  payment(@CurrentSession() s: Session) {
    return this.settings.getPayment(s.accountId);
  }

  /** Тело: { blikPhone?: string | null, recipient?: string | null }. */
  @Patch('account/payment')
  @Roles(['owner'])
  updatePayment(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const raw = (body ?? {}) as Record<string, unknown>;
    const patch = {
      blikPhone: raw.blikPhone === null ? null : input.optString('blikPhone', { max: 30 }),
      recipient: raw.recipient === null ? null : input.optString('recipient', { max: 100 }),
    };
    input.done();
    return this.settings.updatePayment(s.accountId, patch);
  }

  /** Скидки (D-070): { staffCanDiscount } — может ли staff ставить скидку своим клиентам. */
  @Get('account/discounts')
  @Roles(['owner'])
  discounts(@CurrentSession() s: Session) {
    return this.settings.getDiscounts(s.accountId);
  }

  @Patch('account/discounts')
  @Roles(['owner'])
  updateDiscounts(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const staffCanDiscount = input.bool('staffCanDiscount');
    input.done();
    return this.settings.updateDiscounts(s.accountId, staffCanDiscount);
  }

  /** «Ненадёжный клиент» (D-066): порог случаев за 12 месяцев, визитов до снятия, предоплата в % (до 50%, D-014). */
  @Get('account/reliability')
  @Roles(['owner'])
  reliability(@CurrentSession() s: Session) {
    return this.settings.getReliability(s.accountId);
  }

  /** Тело: { threshold?: 1..10, redeemVisits?: 1..10, depositPercent?: 1..50 | null }. */
  @Patch('account/reliability')
  @Roles(['owner'])
  updateReliability(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const raw = (body ?? {}) as Record<string, unknown>;
    const patch = {
      threshold: input.optInt('threshold', { min: 1, max: 10 }),
      redeemVisits: input.optInt('redeemVisits', { min: 1, max: 10 }),
      depositPercent: raw.depositPercent === null ? null : input.optInt('depositPercent', { min: 1, max: 50 }),
    };
    input.done();
    return this.settings.updateReliability(s.accountId, patch);
  }
}
