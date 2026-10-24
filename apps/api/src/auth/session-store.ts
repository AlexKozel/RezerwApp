import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export type UserRole = 'owner' | 'staff' | 'assistant';

export interface Session {
  userId: string;
  accountId: string;
  role: UserRole;
  createdAt: string;
}

/** Срок жизни сессии без активности. Каждое обращение продлевает её (скользящее окно). */
export const SESSION_TTL_SEC = 30 * 24 * 60 * 60;

/**
 * Сессии мастера в Redis (D-041). Браузер хранит случайный токен в httpOnly cookie, Redis хранит сессию
 * под SHA-256 токена: дамп Redis не даёт готовых токенов для входа.
 */
export class SessionStore {
  constructor(private readonly redis: Redis) {}

  private key(token: string): string {
    return `session:${createHash('sha256').update(token).digest('hex')}`;
  }

  async create(data: Omit<Session, 'createdAt'>): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const session: Session = { ...data, createdAt: new Date().toISOString() };
    await this.redis.set(this.key(token), JSON.stringify(session), 'EX', SESSION_TTL_SEC);
    return token;
  }

  async get(token: string): Promise<Session | null> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const key = this.key(token);
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    await this.redis.expire(key, SESSION_TTL_SEC);
    return JSON.parse(raw) as Session;
  }

  async destroy(token: string): Promise<void> {
    await this.redis.del(this.key(token));
  }
}
