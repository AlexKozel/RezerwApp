import type { ManagedBooking } from './api';

/**
 * «Мои записи» на телефоне клиента (D-069, вариант А): ссылки на записи хранятся только в браузере, на сервере
 * ничего не связывается. Все страницы мастеров на одном домене виджета, поэтому список общий для всех мастеров.
 * Сохраняется автоматически после записи и при открытии ссылки записи.
 */
export interface SavedBooking {
  /** Токен ссылки управления записью (/b/<token>). */
  token: string;
  slug: string;
  staffName: string;
  serviceId: string;
  variantId: string;
  service: Record<string, string>;
  variant: Record<string, string>;
  startsAt: string;
  endsAt: string;
  status: string;
  timeZone: string;
}

const KEY = 'rezerwapp.my.v1';
/** Не больше стольких записей: старые вытесняются. */
export const MAX_SAVED = 50;
const ACTIVE = new Set(['pending', 'confirmed']);

/** Добавить или обновить запись (по токену); oldToken: запись была перенесена, старую заменяет новая. */
export function upsert(list: SavedBooking[], entry: SavedBooking, oldToken?: string): SavedBooking[] {
  const rest = list.filter((b) => b.token !== entry.token && b.token !== oldToken);
  return [entry, ...rest].sort((a, b) => b.startsAt.localeCompare(a.startsAt)).slice(0, MAX_SAVED);
}

/** Ближайшие: действующие и ещё не закончившиеся, по времени; остальное в прошлом, новые сверху. */
export function split(list: SavedBooking[], now: Date): { upcoming: SavedBooking[]; past: SavedBooking[] } {
  const iso = now.toISOString();
  const upcoming = list.filter((b) => ACTIVE.has(b.status) && b.endsAt > iso).sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const past = list.filter((b) => !upcoming.includes(b)).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  return { upcoming, past };
}

/** Мастера клиента: по одному на страницу, с последней записью (для «записаться снова»). */
export function masters(list: SavedBooking[]): SavedBooking[] {
  const bySlug = new Map<string, SavedBooking>();
  for (const b of [...list].sort((x, y) => y.startsAt.localeCompare(x.startsAt))) {
    if (!bySlug.has(b.slug)) bySlug.set(b.slug, b);
  }
  return [...bySlug.values()];
}

/** Ссылка «записаться снова»: страница мастера с той же услугой и вариантом. */
export function bookAgainUrl(b: Pick<SavedBooking, 'slug' | 'serviceId' | 'variantId'>, locale: string): string {
  return `/${b.slug}?service=${b.serviceId}&variant=${b.variantId}&lang=${locale}`;
}

function compact(at: string): string {
  return new Date(at).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Google Календарь: шаблон события по ссылке (время в UTC). */
export function googleCalendarUrl(title: string, startsAt: string, endsAt: string, details: string): string {
  const q = new URLSearchParams({ action: 'TEMPLATE', text: title, dates: `${compact(startsAt)}/${compact(endsAt)}`, details });
  return `https://calendar.google.com/calendar/render?${q.toString()}`;
}

// Хранилище браузера может быть недоступно (приватный режим, запрет сайта): тогда список просто пустой.
export function loadSaved(): SavedBooking[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as SavedBooking[]).filter((b) => typeof b?.token === 'string' && typeof b?.slug === 'string') : [];
  } catch {
    return [];
  }
}

export function storeSaved(list: SavedBooking[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // не критично: список только для удобства
  }
}

/** Запись из ответа ссылки управления (/public/bookings/:token). */
export function toSaved(token: string, b: ManagedBooking): SavedBooking {
  return {
    token,
    slug: b.staffSlug,
    staffName: b.staffName,
    serviceId: b.serviceId,
    variantId: b.variantId,
    service: b.service,
    variant: b.variant,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    status: b.status,
    timeZone: b.timeZone,
  };
}

export function forget(token: string): void {
  storeSaved(loadSaved().filter((b) => b.token !== token));
}

export function remember(entry: SavedBooking, oldToken?: string): void {
  storeSaved(upsert(loadSaved(), entry, oldToken));
}
