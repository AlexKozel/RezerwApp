/**
 * Ошибка предметной области с машинным кодом. HTTP-статус выбирает фильтр (http/error.filter.ts),
 * клиенту уходит только код, текст для разработчика.
 */
export class AppError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

/** Некорректные данные запроса. details: имя поля → причина. */
export class ValidationError extends AppError {
  constructor(readonly details: Readonly<Record<string, string>>) {
    super('VALIDATION', `invalid request: ${Object.keys(details).join(', ')}`);
  }
}

export class UnauthorizedError extends AppError {
  constructor() {
    super('UNAUTHORIZED', 'Authentication required');
  }
}

export class TooManyRequestsError extends AppError {
  constructor(readonly retryAfterSec: number) {
    super('RATE_LIMITED', 'Too many requests');
  }
}
