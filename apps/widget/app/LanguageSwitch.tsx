import type { Locale } from '@rezerwapp/shared';
import { LANGUAGE_NAMES, LOCALES } from '../lib/locale';

/** Переключатель языка ссылками ?lang=: работает без JavaScript и сохраняется в адресе при пересылке. */
export function LanguageSwitch({ path, current }: { path: string; current: Locale }) {
  return (
    <nav className="langs" aria-label="Language">
      {LOCALES.map((l) => (
        <a key={l} href={`${path}?lang=${l}`} aria-current={l === current} lang={l}>
          {LANGUAGE_NAMES[l]}
        </a>
      ))}
    </nav>
  );
}
