import type { NestExpressApplication } from '@nestjs/platform-express';

/** Лимит тела text/csv: импорт клиентов (до 5000 строк). JSON остаётся с лимитом Nest по умолчанию (100 КБ). */
export const CSV_BODY_LIMIT = '2mb';

/**
 * Значение TRUST_PROXY для Express: чьему X-Forwarded-For верить при определении IP клиента (лимиты частоты).
 * Не задано: никому (IP = адрес соединения). «loopback»: прокси на той же машине (виджет в разработке);
 * число: столько прокси перед API в проде. Доверять всем нельзя: IP в лимитах можно было бы подделать.
 */
export function trustProxySetting(raw: string | undefined): string | number | false {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') throw new Error('TRUST_PROXY=true would trust any X-Forwarded-For; set a hop count or "loopback"');
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/** Общая настройка приложения: для main.ts и для тестов, чтобы тесты проверяли то же, что работает в проде. */
export function configureApp(app: NestExpressApplication, trustProxy: string | undefined = process.env.TRUST_PROXY): void {
  const trust = trustProxySetting(trustProxy);
  if (trust !== false) app.set('trust proxy', trust);
  app.useBodyParser('text', { type: ['text/csv', 'text/plain'], limit: CSV_BODY_LIMIT });
  app.enableShutdownHooks();
}
