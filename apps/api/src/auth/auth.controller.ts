import { Body, Controller, Get, HttpCode, Inject, Ip, Post, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { APP_CONFIG } from '../app.tokens';
import type { AppConfig } from '../config';
import { serializeCookie } from '../http/cookies';
import { Input } from '../http/validate';
import { CurrentSession, SESSION_COOKIE, SessionGuard, SessionToken } from './auth.guard';
import { AuthService } from './auth.service';
import { SESSION_TTL_SEC, type Session } from './session-store';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Post('login')
  @HttpCode(200)
  async login(@Body() body: unknown, @Ip() ip: string, @Res({ passthrough: true }) res: Response) {
    const input = new Input(body);
    const email = input.string('email', { max: 254 });
    const password = input.string('password', { max: 1000 });
    input.done();
    const { token, session } = await this.auth.login(email, password, ip);
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, token, { maxAgeSec: SESSION_TTL_SEC, secure: this.config.cookieSecure }));
    return { accountId: session.accountId, role: session.role };
  }

  @Post('logout')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async logout(@SessionToken() token: string | undefined, @Res({ passthrough: true }) res: Response): Promise<void> {
    if (token) await this.auth.logout(token);
    res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSec: 0, secure: this.config.cookieSecure }));
  }

  @Get('me')
  @UseGuards(SessionGuard)
  me(@CurrentSession() session: Session) {
    return { userId: session.userId, accountId: session.accountId, role: session.role };
  }
}
