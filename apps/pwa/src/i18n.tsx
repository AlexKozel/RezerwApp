import { DEFAULT_LOCALE, isLocale, t as translate, type Locale, type MessageKey, type MessageParams } from '@rezerwapp/shared';
import { createContext, useContext, type ReactNode } from 'react';

const STORAGE_KEY = 'rezerwapp.lang';

/** Язык интерфейса: выбранный мастером на этом устройстве, иначе язык Account, иначе браузера (D-036). */
export function initialLocale(accountLocale?: string): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // хранилище может быть недоступно (приватный режим): работаем без него
  }
  if (isLocale(accountLocale)) return accountLocale;
  const browser = navigator.language.slice(0, 2);
  return isLocale(browser) ? browser : DEFAULT_LOCALE;
}

export function saveLocale(locale: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // не критично
  }
}

const LocaleContext = createContext<Locale>(DEFAULT_LOCALE);

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

/** t() текущего языка интерфейса. */
export function useT(): { locale: Locale; t: (key: MessageKey, params?: MessageParams) => string } {
  const locale = useContext(LocaleContext);
  return { locale, t: (key, params) => translate(locale, key, params) };
}
