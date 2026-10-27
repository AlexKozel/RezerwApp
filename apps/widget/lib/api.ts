/**
 * Доступ к API. На сервере (SSR) напрямую по API_URL; в браузере через /api того же домена: в разработке это
 * rewrite Next (next.config.ts), в проде обратный прокси. Так нет CORS, и cookie не нужны: виджет без входа.
 */
export const API_URL = process.env.API_URL ?? 'http://localhost:3001';

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | undefined;
  error: string | undefined;
  /** Поля ответа с ошибкой (например, сумма при DEPOSIT_REQUIRED). */
  details: Record<string, unknown> | undefined;
}

async function parse<T>(res: Response): Promise<ApiResult<T>> {
  const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : undefined;
  return {
    ok: res.ok,
    status: res.status,
    data: res.ok ? (body as T) : undefined,
    error: res.ok ? undefined : (body?.error as string | undefined),
    details: res.ok ? undefined : body,
  };
}

/** Серверный запрос (Server Components): без кэша, данные записи меняются каждую минуту. */
export async function serverGet<T>(path: string, forwardedFor?: string | null): Promise<ApiResult<T>> {
  const res = await fetch(`${API_URL}${path}`, {
    cache: 'no-store',
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });
  return parse<T>(res);
}

/** Запрос из браузера (Client Components). */
export async function clientCall<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return parse<T>(res);
  } catch {
    return { ok: false, status: 0, data: undefined, error: 'NETWORK', details: undefined };
  }
}

/** Типы ответов публичного API (apps/api/src/public). */
export interface PublicService {
  id: string;
  name: Record<string, string>;
  category: string | null;
  bookingFee: { mode: 'fixed' | 'percent'; value: number; appliesTo: 'new_clients' | 'all'; method: string } | null;
  variants: Array<{ id: string; name: Record<string, string>; durationMin: number; price: number }>;
}

export interface PublicProfile {
  displayName: string;
  timeZone: string;
  services: PublicService[];
}

export interface BookingResult {
  bookingId: string;
  status: string;
  startsAt: string;
  endsAt: string;
  holdExpiresAt: string | null;
  bookingFee: { amount: number; code: string; method: string; blikPhone: string | null; recipient: string | null } | null;
  manageToken: string;
  /** Оплата взята по правилу мастера для повторяющихся неявок: визитов до её отмены (D-066). */
  unreliableVisitsLeft: number | null;
}

export interface ManagedBooking {
  status: string;
  startsAt: string;
  endsAt: string;
  staffName: string;
  staffSlug: string;
  timeZone: string;
  service: Record<string, string>;
  variant: Record<string, string>;
  policy: { freeCancelHours: number; maxReschedules: number; rescheduleCount: number; deadline: string };
  canCancel: boolean;
  lateCancel: boolean;
  canReschedule: boolean;
  contactMaster: boolean;
  bookingFee: { amount: number; code: string; status: string; blikPhone: string | null; recipient: string | null } | null;
  rescheduledToToken: string | null;
}
