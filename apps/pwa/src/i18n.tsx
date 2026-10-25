import { DEFAULT_LOCALE, isLocale, t as translate, type Locale, type MessageKey, type MessageParams } from '@rezerwapp/shared';
import { createContext, useContext, useMemo, type ReactNode } from 'react';

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

interface LocaleValue {
  locale: Locale;
  t: (key: MessageKey, params?: MessageParams) => string;
}

const LocaleContext = createContext<LocaleValue>({ locale: DEFAULT_LOCALE, t: (key, params) => translate(DEFAULT_LOCALE, key, params) });

/**
 * t() создаётся один раз на язык. Экраны указывают t в зависимостях загрузки данных: если бы функция менялась
 * на каждом рендере, загрузка запускалась бы по кругу (календарь делал сотни запросов в секунду).
 */
export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<LocaleValue>(() => ({ locale, t: (key, params) => translate(locale, key, params) }), [locale]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/** Текущий язык и t() интерфейса; t стабильна, пока не сменится язык. */
export function useT(): LocaleValue {
  return useContext(LocaleContext);
}
