import type { NestExpressApplication } from '@nestjs/platform-express';

/** Лимит тела text/csv: импорт клиентов (до 5000 строк). JSON остаётся с лимитом Nest по умолчанию (100 КБ). */
export const CSV_BODY_LIMIT = '2mb';

/** Общая настройка приложения: для main.ts и для тестов, чтобы тесты проверяли то же, что работает в проде. */
export function configureApp(app: NestExpressApplication): void {
  app.useBodyParser('text', { type: ['text/csv', 'text/plain'], limit: CSV_BODY_LIMIT });
  app.enableShutdownHooks();
}
