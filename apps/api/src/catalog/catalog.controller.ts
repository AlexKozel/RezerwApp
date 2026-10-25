import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { CurrentSession, Roles, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { Input } from '../http/validate';
import { CatalogService, type ServiceInput, type VariantInput } from './catalog.service';

const PREPAYMENT = ['none', 'manual_blik', 'provider_link'] as const;
const DEPOSIT_MODE = ['none', 'fixed', 'percent'] as const;
const DEPOSIT_SCOPE = ['new_clients', 'all'] as const;

function readVariant(input: Input, partial: boolean): Partial<VariantInput> & { active?: boolean } {
  const pick = <T>(key: string, read: () => T): T | undefined => (partial && !input.has(key) ? undefined : read());
  return {
    name: pick('name', () => input.i18nText('name', { required: false })),
    durationMin: pick('durationMin', () => input.int('durationMin', { min: 5, max: 24 * 60 })),
    bufferMin: pick('bufferMin', () => input.optInt('bufferMin', { min: 0, max: 240 }) ?? 0),
    price: pick('price', () => input.money('price')),
    active: input.optBool('active'),
  };
}

function readService(input: Input, partial: boolean): Partial<ServiceInput> & { active?: boolean } {
  const pick = <T>(key: string, read: () => T): T | undefined => (partial && !input.has(key) ? undefined : read());
  return {
    name: pick('name', () => input.i18nText('name')),
    category: pick('category', () => input.optString('category', { max: 100 }) ?? null),
    prepaymentMethod: pick('prepaymentMethod', () => input.optOneOf('prepaymentMethod', PREPAYMENT) ?? 'none'),
    depositMode: pick('depositMode', () => input.optOneOf('depositMode', DEPOSIT_MODE) ?? 'none'),
    depositValue: pick('depositValue', () => (input.has('depositValue') ? input.money('depositValue') : 0)),
    depositScope: pick('depositScope', () => input.optOneOf('depositScope', DEPOSIT_SCOPE) ?? 'new_clients'),
    requiresManualConfirm: pick('requiresManualConfirm', () => input.optBool('requiresManualConfirm') ?? true),
    cancelPolicyId: pick('cancelPolicyId', () => input.optUuid('cancelPolicyId') ?? null),
    costPrice: pick('costPrice', () => (input.has('costPrice') ? input.money('costPrice') : null)),
    active: input.optBool('active'),
  };
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Настройка каталога. Account всегда из сессии; менять каталог может только owner, читать любая роль. */
@Controller()
@UseGuards(SessionGuard)
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get('staff')
  listStaff(@CurrentSession() s: Session) {
    return this.catalog.listStaff(s.accountId);
  }

  @Post('staff')
  @Roles(['owner'])
  createStaff(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const displayName = input.string('displayName', { max: 100 });
    const publicSlug = input.string('publicSlug', { max: 40 }).toLowerCase();
    input.done();
    return this.catalog.createStaff(s.accountId, { displayName, publicSlug });
  }

  @Get('policies')
  listPolicies(@CurrentSession() s: Session) {
    return this.catalog.listPolicies(s.accountId);
  }

  @Post('policies')
  @Roles(['owner'])
  createPolicy(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const policy = {
      freeCancelHours: input.optInt('freeCancelHours', { min: 0, max: 24 * 14 }) ?? 24,
      maxReschedules: input.optInt('maxReschedules', { min: 0, max: 10 }) ?? 1,
      holdMinutes: input.optInt('holdMinutes', { min: 5, max: 1440 }) ?? 120,
      depositOnLateCancel: input.optOneOf('depositOnLateCancel', ['keep', 'transfer', 'refund'] as const) ?? 'keep',
      texts: input.i18nText('texts', { required: false, max: 4000 }),
    };
    input.done();
    return this.catalog.createPolicy(s.accountId, policy);
  }

  @Get('services')
  listServices(@CurrentSession() s: Session) {
    return this.catalog.listServices(s.accountId);
  }

  @Post('services')
  @Roles(['owner'])
  createService(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const service = readService(input, false) as ServiceInput;
    const variants = input.list('variants', { max: 30 }).map((v) => readVariant(v, false) as VariantInput);
    input.done();
    return this.catalog.createService(s.accountId, service, variants);
  }

  @Patch('services/:id')
  @Roles(['owner'])
  updateService(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = new Input(body);
    const patch = withoutUndefined(readService(input, true));
    input.done();
    return this.catalog.updateService(s.accountId, id, patch);
  }

  @Post('services/:id/variants')
  @Roles(['owner'])
  addVariant(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = new Input(body);
    const variant = readVariant(input, false) as VariantInput;
    input.done();
    return this.catalog.addVariant(s.accountId, id, variant);
  }

  @Patch('variants/:id')
  @Roles(['owner'])
  updateVariant(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = new Input(body);
    const patch = withoutUndefined(readVariant(input, true));
    input.done();
    return this.catalog.updateVariant(s.accountId, id, patch);
  }

  @Put('staff/:staffId/services/:serviceId')
  @Roles(['owner'])
  @HttpCode(204)
  async assign(
    @CurrentSession() s: Session,
    @Param('staffId', ParseUUIDPipe) staffId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Body() body: unknown,
  ): Promise<void> {
    const input = new Input(body ?? {});
    const durationMin = input.optInt('overrideDurationMin', { min: 5, max: 24 * 60 }) ?? null;
    const price = input.has('overridePrice') ? input.money('overridePrice') : null;
    input.done();
    await this.catalog.assignStaff(s.accountId, staffId, serviceId, { durationMin, price });
  }

  @Delete('staff/:staffId/services/:serviceId')
  @Roles(['owner'])
  @HttpCode(204)
  async unassign(
    @CurrentSession() s: Session,
    @Param('staffId', ParseUUIDPipe) staffId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
  ): Promise<void> {
    await this.catalog.unassignStaff(s.accountId, staffId, serviceId);
  }
}
