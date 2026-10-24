/** Языки продукта (D-036). Юридически приоритетная версия текстов: польская. */
export const LOCALES = ['pl', 'uk', 'ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'pl';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
