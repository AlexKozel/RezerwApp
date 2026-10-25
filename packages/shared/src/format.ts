/** Форматирование для интерфейсов (виджет клиента и PWA мастера): язык клиента, пояс Account. */
import type { Locale } from './locale';
import { localDate } from './zoned-time';

const INTL_LOCALE: Record<Locale, string> = { pl: 'pl-PL', uk: 'uk-UA', ru: 'ru-RU', en: 'en-GB' };

/** Текст на языке клиента; иначе польский, иначе любой доступный (name_i18n услуг). */
export function pickText(texts: Record<string, string> | undefined, locale: Locale): string {
  if (!texts) return '';
  return texts[locale] ?? texts.pl ?? Object.values(texts)[0] ?? '';
}

/** Сумма в злотых: целые без копеек, иначе два знака (30, 30,50). */
export function formatMoney(amount: number, locale: Locale): string {
  return new Intl.NumberFormat(INTL_LOCALE[locale], { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 }).format(amount);
}

export function formatTime(at: Date, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, hour: '2-digit', minute: '2-digit' }).format(at);
}

export function formatDayLabel(day: string, locale: Locale): string {
  // Полдень UTC: дата не съезжает ни в одном поясе.
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(
    new Date(`${day}T12:00:00Z`),
  );
}

export function formatWhen(at: Date, timeZone: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(at);
}

/** Слоты по местным дням Account в порядке времени. */
export function groupByDay(slots: string[], timeZone: string): Array<{ day: string; slots: Date[] }> {
  const groups = new Map<string, Date[]>();
  for (const iso of [...slots].sort()) {
    const at = new Date(iso);
    const day = localDate(at, timeZone);
    let list = groups.get(day);
    if (!list) groups.set(day, (list = []));
    list.push(at);
  }
  return [...groups].map(([day, list]) => ({ day, slots: list }));
}

/** Оставшееся время hold: «1:05:09» или «4:59». */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** День рождения "MM-DD" для показа: «12 marca», «12 березня». 2000 год високосный: 29 февраля тоже. */
export function formatBirthday(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', day: 'numeric', month: 'long' }).format(new Date(`2000-${value}T12:00:00Z`));
}

/** Название месяца для выбора даты рождения (1-12). */
export function monthName(month: number, locale: Locale): string {
  return new Intl.DateTimeFormat(INTL_LOCALE[locale], { timeZone: 'UTC', month: 'long' }).format(new Date(Date.UTC(2000, month - 1, 15)));
}
