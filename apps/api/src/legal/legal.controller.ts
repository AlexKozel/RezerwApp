import { Body, Controller, Get, HttpCode, Ip, Param, Post, Query, UseGuards } from '@nestjs/common';
import { LOCALES } from '@rezerwapp/shared';
import { CurrentSession, Roles, SessionGuard, SkipAcceptance } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { SLUG_RE } from '../catalog/catalog.service';
import { NotFoundError } from '../errors';
import { Input } from '../http/validate';
import { CLIENT_DOCUMENTS, LegalService, PLATFORM_DOCUMENTS } from './legal.service';

/** Юридические документы (D-055). */
@Controller()
export class LegalController {
  constructor(private readonly legal: LegalService) {}

  /** Текущие документы платформы для Account и отметка принятия. Доступно до принятия. */
  @Get('legal/platform')
  @UseGuards(SessionGuard)
  @SkipAcceptance(true)
  platform(@CurrentSession() s: Session) {
    return this.legal.platformDocuments(s.accountId);
  }

  /** owner принимает документы от имени Account. Тело: { documents: [{ type, version }] }. */
  @Post('legal/accept')
  @UseGuards(SessionGuard)
  @SkipAcceptance(true)
  @Roles(['owner'])
  @HttpCode(200)
  async accept(@CurrentSession() s: Session, @Body() body: unknown, @Ip() ip: string) {
    const input = new Input(body);
    const documents = input.list('documents', { max: PLATFORM_DOCUMENTS.length }).map((d) => ({
      type: d.oneOf('type', PLATFORM_DOCUMENTS),
      version: d.string('version', { max: 40 }),
    }));
    input.done();
    return { pending: await this.legal.accept(s.accountId, s.userId, documents, ip) };
  }

  /** Клиентский документ специалиста для чтения перед записью (без входа). */
  @Get('public/staff/:slug/legal/:type')
  publicDocument(@Param('slug') slug: string, @Param('type') type: string, @Query() query: unknown) {
    if (!SLUG_RE.test(slug) || !(CLIENT_DOCUMENTS as readonly string[]).includes(type)) throw new NotFoundError('document');
    const input = new Input(query);
    const language = input.optOneOf('language', LOCALES) ?? 'pl';
    input.done();
    return this.legal.publicDocument(slug, type as (typeof CLIENT_DOCUMENTS)[number], language);
  }
}
