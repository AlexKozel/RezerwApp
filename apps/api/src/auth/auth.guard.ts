import { createParamDecorator, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '../errors';
import { parseCookies } from '../http/cookies';
import { SessionStore, type Session } from './session-store';

export const SESSION_COOKIE = 'rz_sid';

type AuthedRequest = Request & { session?: Session; sessionToken?: string };

/** Пропускает запрос только с действующей сессией мастера; Account берётся из сессии, не из запроса. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionStore) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = token ? await this.sessions.get(token) : null;
    if (!session || !token) throw new UnauthorizedError();
    req.session = session;
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
