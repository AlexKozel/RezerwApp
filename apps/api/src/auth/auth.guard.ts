import { createParamDecorator, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { DbService } from '../db/db.service';
import { AppError, UnauthorizedError } from '../errors';
import { parseCookies } from '../http/cookies';
import { AcceptanceRequiredError, pendingPlatformDocuments } from '../legal/legal.service';
import { SessionStore, type Session, type UserRole } from './session-store';

export const SESSION_COOKIE = 'rz_sid';

/** Роли, которым доступен эндпоинт (DATA_MODEL.md, раздел 4). Без декоратора доступно любой роли Account. */
export const Roles = Reflector.createDecorator<UserRole[]>();

/** Маршрут доступен до принятия документов платформы (вход, профиль, пароль, сами документы; D-055). */
export const SkipAcceptance = Reflector.createDecorator<true>();

export class ForbiddenError extends AppError {
  constructor() {
    super('FORBIDDEN', 'Not allowed for this role');
  }
}

type AuthedRequest = Request & { session?: Session; sessionToken?: string };

/**
 * Пропускает запрос только с действующей сессией мастера; Account берётся из сессии, не из запроса.
 * Пользователь и его роль перечитываются из БД на каждом запросе: удаление пользователя, смена роли
 * или приостановка Account действуют сразу, а не после истечения сессии. Пока owner не принял текущие
 * документы платформы (D-055), закрыто всё, кроме маршрутов с @SkipAcceptance.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionStore,
    private readonly db: DbService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const stored = token ? await this.sessions.get(token) : null;
    if (!stored || !token) throw new UnauthorizedError();

    const skipAcceptance = this.reflector.getAllAndOverride(SkipAcceptance, [context.getHandler(), context.getClass()]) === true;
    const { user, pending } = await this.db.withAccount(stored.accountId, async (client) => {
      const row = await client.query<{ role: UserRole }>(
        "SELECT u.role FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.id = $1 AND a.status = 'active'",
        [stored.userId],
      );
      return { user: row.rows[0], pending: skipAcceptance || !row.rows[0] ? [] : await pendingPlatformDocuments(client) };
    });
    if (!user) {
      await this.sessions.destroy(token);
      throw new UnauthorizedError();
    }

    const allowed = this.reflector.getAllAndOverride(Roles, [context.getHandler(), context.getClass()]);
    if (allowed && !allowed.includes(user.role)) throw new ForbiddenError();
    if (pending.length > 0) throw new AcceptanceRequiredError(pending);

    req.session = { ...stored, role: user.role };
    req.sessionToken = token;
    return true;
  }
}

/** Сессия, проверенная SessionGuard. */
export const CurrentSession = createParamDecorator((_data: unknown, context: ExecutionContext): Session => {
  const session = context.switchToHttp().getRequest<AuthedRequest>().session;
  if (!session) throw new UnauthorizedError();
  return session;
});

export const SessionToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => context.switchToHttp().getRequest<AuthedRequest>().sessionToken,
);
