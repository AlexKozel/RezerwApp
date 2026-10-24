import type { Locale } from '../locale';
import { en } from './en';
import { pl, type MessageKey } from './pl';
import { ru } from './ru';
import { uk } from './uk';

export type { MessageKey };

export const messages: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = { pl, uk, ru, en };

export type MessageParams = Readonly<Record<string, string | number>>;

/**
 * Возвращает сообщение с подстановкой {параметров}. Отсутствующий параметр это ошибка программиста,
 * поэтому бросаем исключение, а не показываем клиенту сырой шаблон.
 */
export function t(locale: Locale, key: MessageKey, params: MessageParams = {}): string {
  return messages[locale][key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) throw new Error(`i18n: missing param "${name}" for key "${key}" (${locale})`);
    return String(value);
  });
}

export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();
}
