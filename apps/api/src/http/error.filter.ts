import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Response } from 'express';
import { AppError, TooManyRequestsError, ValidationError } from '../errors';

const STATUS: Readonly<Record<string, number>> = {
  VALIDATION: 400,
  OTP_INVALID: 400,
  CONSENT_REQUIRED: 400,
  INVITE_INVALID: 400,
  SLOT_NOT_AVAILABLE: 409,
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  LEGAL_TEXTS_MISSING: 503,
};

/** Нарушения ограничений БД, которые означают ошибку данных запроса, а не сбой сервера. */
const PG_STATUS: Readonly<Record<string, [number, string]>> = {
  '23505': [409, 'ALREADY_EXISTS'],
  '23514': [400, 'CONSTRAINT_VIOLATION'],
  '23503': [400, 'REFERENCE_INVALID'],
};

/**
 * Переводит ошибки предметной области в HTTP. Наружу уходит машинный код (клиент показывает текст из i18n),
 * без стека и без текста SQL. Блокировка клиента (blacklist) отдаётся нейтрально, как «нет свободных мест»
 * (BOOKING_FLOW.md, раздел 8).
 */
@Catch()
export class AppErrorFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof AppError) {
      if (exception instanceof TooManyRequestsError) res.setHeader('Retry-After', String(exception.retryAfterSec));
      const code = exception.code === 'CLIENT_BLOCKED' ? 'NO_FREE_SLOTS' : exception.code;
      const body: Record<string, unknown> = { ...exception.meta, error: code };
      if (exception instanceof ValidationError) body.details = exception.details;
      res.status(STATUS[exception.code] ?? 409).json(body);
      return;
    }

    const pgCode = (exception as { code?: unknown } | null)?.code;
    const mapped = typeof pgCode === 'string' ? PG_STATUS[pgCode] : undefined;
    if (mapped) {
      const constraint = (exception as { constraint?: string }).constraint;
      res.status(mapped[0]).json({ error: mapped[1], ...(constraint ? { constraint } : {}) });
      return;
    }

    super.catch(exception, host);
  }
}
