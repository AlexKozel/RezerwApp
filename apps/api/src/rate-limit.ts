import type { Redis } from 'ioredis';
import { TooManyRequestsError } from './errors';

/**
 * Лимит частоты в фиксированном окне (ARCHITECTURE.md, раздел 9: лимиты на вход, OTP и заявки).
 * Счётчик в Redis общий для всех экземпляров API.
 */
export class RateLimiter {
  constructor(private readonly redis: Redis) {}

  /** Учитывает попытку и бросает TooManyRequestsError, если лимит превышен. */
  async hit(bucket: string, limit: number, windowSec: number): Promise<void> {
    const key = `rl:${bucket}`;
    const [[, count], [, ttl]] = (await this.redis.multi().incr(key).ttl(key).exec()) as [[null, number], [null, number]];
    if (ttl < 0) await this.redis.expire(key, windowSec);
    if (count > limit) throw new TooManyRequestsError(ttl > 0 ? ttl : windowSec);
  }

  /** Проверяет лимит, не учитывая попытку (например, перед проверкой пароля). */
  async check(bucket: string, limit: number): Promise<void> {
    const key = `rl:${bucket}`;
    const count = Number((await this.redis.get(key)) ?? 0);
    if (count >= limit) throw new TooManyRequestsError(Math.max(await this.redis.ttl(key), 1));
  }

  async reset(bucket: string): Promise<void> {
    await this.redis.del(`rl:${bucket}`);
  }
}
