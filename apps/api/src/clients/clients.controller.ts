import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards } from '@nestjs/common';
import { LOCALES } from '@rezerwapp/shared';
import type { Response } from 'express';
import { StaffAccess } from '../auth/access';
import { CurrentSession, Roles, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { ValidationError } from '../errors';
import { Input } from '../http/validate';
import { BLACKLIST_DEFAULT_DAYS, CrmService, toCsv, type Viewer } from './crm.service';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * CRM (D-050). owner и assistant видят всю базу Account, staff только своих клиентов (с записями к нему).
 * Заметки и blacklist: owner и staff; экспорт, анонимизация и журнал аудита: только owner.
 */
@Controller()
@UseGuards(SessionGuard)
export class ClientsController {
  constructor(
    private readonly crm: CrmService,
    private readonly access: StaffAccess,
  ) {}

  private async viewer(s: Session): Promise<Viewer> {
    return { accountId: s.accountId, userId: s.userId, staffIds: await this.access.scope(s) };
  }

  @Get('clients')
  async list(@CurrentSession() s: Session, @Query() query: unknown) {
    const input = new Input(query);
    const search = input.optString('search', { max: 100 });
    const offset = input.optInt('offset', { min: 0, max: 100_000 });
    input.done();
    return this.crm.list(await this.viewer(s), { search, offset });
  }

  @Post('clients')
  async create(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const client = {
      name: input.string('name', { max: 100 }),
      phone: input.string('phone', { max: 30 }),
      language: input.optOneOf('language', LOCALES) ?? 'pl',
      email: input.optString('email', { max: 254, pattern: EMAIL_RE }) ?? null,
    };
    input.done();
    return this.crm.create(await this.viewer(s), client);
  }

  /** Экспорт базы (D-022). ?format=csv отдаёт CSV клиентов, иначе JSON с клиентами, записями и согласиями. */
  @Get('clients/export')
  @Roles(['owner'])
  async export(@CurrentSession() s: Session, @Query() query: unknown, @Res({ passthrough: true }) res: Response) {
    const input = new Input(query);
    const format = input.optOneOf('format', ['json', 'csv'] as const) ?? 'json';
    input.done();
    const data = await this.crm.export(await this.viewer(s));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="clients-${stamp}.json"`);
      return data;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="clients-${stamp}.csv"`);
    // BOM: Excel иначе открывает UTF-8 (польские и кириллические имена) в неверной кодировке.
    return '﻿' + toCsv(data.clients, ['id', 'name', 'phone', 'email', 'language', 'createdAt', 'anonymizedAt']);
  }

  /**
   * Импорт базы клиентов (D-054). Тело: CSV как text/csv (до 2 МБ, 5000 строк), колонки name/imię/имя и
   * phone/telefon/телефон обязательны, email и language необязательны. ?dryRun=true: только отчёт, без записи.
   */
  @Post('clients/import')
  @Roles(['owner'])
  @HttpCode(200)
  async import(@CurrentSession() s: Session, @Body() body: unknown, @Query() query: unknown) {
    const input = new Input(query);
    const dryRun = input.optOneOf('dryRun', ['true', 'false'] as const) === 'true';
    input.done();
    if (typeof body !== 'string') throw new ValidationError({ csv: 'send the file as text/csv' });
    return this.crm.importCsv(await this.viewer(s), body, dryRun);
  }

  @Get('clients/:id')
  async card(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    return this.crm.card(await this.viewer(s), id);
  }

  @Patch('clients/:id')
  @HttpCode(204)
  async update(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown): Promise<void> {
    const input = new Input(body);
    const raw = (body ?? {}) as Record<string, unknown>;
    const patch = {
      name: input.optString('name', { max: 100 }),
      email: raw.email === null ? null : input.optString('email', { max: 254, pattern: EMAIL_RE }),
      language: input.optOneOf('language', LOCALES),
    };
    input.done();
    await this.crm.update(await this.viewer(s), id, patch);
  }

  /** Удаление данных клиента по его запросу (RODO): анонимизация, история визитов сохраняется. */
  @Delete('clients/:id')
  @Roles(['owner'])
  @HttpCode(204)
  async anonymize(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.crm.anonymize(await this.viewer(s), id);
  }

  @Get('clients/:id/notes')
  @Roles(['owner', 'staff'])
  async notes(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string) {
    return this.crm.notes(await this.viewer(s), id);
  }

  /** Тело: { body, sensitivity?: "normal" | "health" }. Диагнозы не вносить (подсказка notes.health_warning). */
  @Post('clients/:id/notes')
  @Roles(['owner', 'staff'])
  async addNote(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = new Input(body);
    const text = input.string('body', { max: 5000 });
    const sensitivity = input.optOneOf('sensitivity', ['normal', 'health'] as const) ?? 'normal';
    input.done();
    return this.crm.addNote(await this.viewer(s), id, text, sensitivity);
  }

  @Delete('clients/:id/notes/:noteId')
  @Roles(['owner', 'staff'])
  @HttpCode(204)
  async deleteNote(
    @CurrentSession() s: Session,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('noteId', ParseUUIDPipe) noteId: string,
  ): Promise<void> {
    await this.crm.deleteNote(await this.viewer(s), id, noteId);
  }

  /** Тело: { reason?, days? } (срок по умолчанию 2 года, D-024). */
  @Post('clients/:id/blacklist')
  @Roles(['owner', 'staff'])
  async blacklist(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const input = new Input(body ?? {});
    const reason = input.optString('reason', { max: 500 }) ?? null;
    const days = input.optInt('days', { min: 1, max: BLACKLIST_DEFAULT_DAYS }) ?? BLACKLIST_DEFAULT_DAYS;
    input.done();
    return this.crm.blacklist(await this.viewer(s), id, reason, days);
  }

  @Delete('clients/:id/blacklist')
  @Roles(['owner', 'staff'])
  @HttpCode(204)
  async unblacklist(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.crm.unblacklist(await this.viewer(s), id);
  }

  @Get('audit')
  @Roles(['owner'])
  async audit(@CurrentSession() s: Session, @Query() query: unknown) {
    const input = new Input(query);
    const offset = input.optInt('offset', { min: 0, max: 100_000 });
    input.done();
    return this.crm.auditLog(await this.viewer(s), offset);
  }
}
