/**
 * Клиент API мастера: /api того же домена, cookie сессии отправляется браузером (HttpOnly, D-041).
 * 401 и 403 ACCEPTANCE_REQUIRED обрабатывает App (вход и принятие документов), остальное экраны.
 */
export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | undefined;
  error: string | undefined;
}

type Listener = (status: number, error: string | undefined) => void;
let listener: Listener = () => undefined;

/** App подписывается, чтобы реагировать на истёкшую сессию и требование принять документы. */
export function onAuthProblem(fn: Listener): void {
  listener = fn;
}

export async function api<T = unknown>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    return { ok: false, status: 0, data: undefined, error: 'OFFLINE' };
  }
  const json = res.headers.get('content-type')?.includes('application/json') ? await res.json() : undefined;
  const error = res.ok ? undefined : (json?.error as string | undefined);
  if (res.status === 401 || error === 'ACCEPTANCE_REQUIRED' || error === 'PASSWORD_CHANGE_REQUIRED') listener(res.status, error);
  return { ok: res.ok, status: res.status, data: res.ok ? (json as T) : undefined, error };
}

export type Role = 'owner' | 'staff' | 'assistant';

export interface Me {
  userId: string;
  accountId: string;
  role: Role;
  accountName: string;
  timeZone: string;
  locale: string;
  email: string;
  staffId: string | null;
  /** Вход по временному паролю от owner'а: сначала смена пароля (D-061). */
  mustChangePassword: boolean;
  pendingDocuments: Array<{ type: string; version: string }>;
}

export interface Staff {
  id: string;
  displayName: string;
  publicSlug: string;
  active: boolean;
}

export interface CalendarBooking {
  id: string;
  staffId: string;
  clientId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  version: number;
  holdExpiresAt: string | null;
  clientName: string;
  staffName: string;
  serviceName: Record<string, string>;
  variantName: Record<string, string>;
  price: number | null;
  payment: { amount: number; code: string; status: string } | null;
}

export interface ServiceItem {
  id: string;
  name: Record<string, string>;
  active: boolean;
  variants: Array<{ id: string; name: Record<string, string>; durationMin: number; price: number; active: boolean }>;
}

export interface ClientSummary {
  id: string;
  name: string;
  anonymized: boolean;
}

export interface ClientCard extends ClientSummary {
  phone: string | null;
  email: string | null;
  language: string;
  blacklisted: { reason: string | null; expiresAt: string } | null;
  stats: { completed: number; noShow: number; cancelledByClient: number };
  bookings: Array<{ id: string; staffId: string; startsAt: string; status: string }>;
  consents: Array<{ type: string; textVersion: string; givenAt: string; revokedAt: string | null }>;
}
