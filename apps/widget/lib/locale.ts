import { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from '@rezerwapp/shared';

/**
 * Язык страницы (D-036): явный ?lang=, иначе первый поддерживаемый из Accept-Language, иначе польский.
 * Клиенты из Украины часто приходят с uk-UA или ru-RU в браузере.
 */
export function pickLocale(param: string | string[] | undefined, acceptLanguage: string | null): Locale {
  const explicit = Array.isArray(param) ? param[0] : param;
  if (isLocale(explicit)) return explicit;
  for (const part of (acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]!.trim().toLowerCase().slice(0, 2);
    if (isLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}

export const LANGUAGE_NAMES: Record<Locale, string> = { pl: 'Polski', uk: 'Українська', ru: 'Русский', en: 'English' };
export { LOCALES };
