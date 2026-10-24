/** Разбор заголовка Cookie без зависимостей. Повреждённые значения пропускаются. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    try {
      result[name] ??= decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      // некорректное %-кодирование: игнорируем cookie
    }
  }
  return result;
}

export interface CookieOptions {
  maxAgeSec: number;
  secure: boolean;
}

/** Cookie сессии: недоступна JS (HttpOnly), не уходит с межсайтовыми POST (SameSite=Lax). */
export function serializeCookie(name: string, value: string, { maxAgeSec, secure }: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
