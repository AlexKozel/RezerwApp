import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from './app.tokens';
import { DbService } from './db/db.service';

const REDIS_TIMEOUT_MS = 1000;

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: DbService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.db.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'database_unavailable' });
    }
    try {
      // Пока Redis недоступен, ioredis держит команды в очереди: ждём ответа не дольше секунды.
      await Promise.race([
        this.redis.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), REDIS_TIMEOUT_MS).unref()),
      ]);
    } catch {
      throw new ServiceUnavailableException({ status: 'redis_unavailable' });
    }
    return { status: 'ok' };
  }
}
