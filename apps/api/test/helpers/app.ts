import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Redis } from 'ioredis';
import { AppModule } from '../../src/app.module';
import { APP_CONFIG, REDIS } from '../../src/app.tokens';
import type { AppConfig } from '../../src/config';
import { DbService } from '../../src/db/db.service';
import type { TestDb } from './test-db';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';
export const TEST_OTP = '4321';

export const TEST_CONFIG: AppConfig = {
  production: false,
  databaseUrl: 'unused: DbService is replaced',
  redisUrl: TEST_REDIS_URL,
  // Фиксированные тестовые секреты: тесты не зависят от реальных (D-042).
  phoneHashPepper: 'test-pepper',
  fieldMasterKey: Buffer.alloc(32, 7),
  alphaOtpCode: TEST_OTP,
  cookieSecure: false,
  // Фоновые задачи проверяются отдельно (jobs.test.ts), здесь они мешали бы детерминированности.
  workers: false,
};

export interface TestApp {
  app: INestApplication;
  url: string;
  redis: Redis;
  close(): Promise<void>;
}

/**
 * Приложение целиком (контроллеры, guard, фильтр ошибок) поверх тестовой БД под ролью приложения и Redis
 * с уникальным префиксом ключей: прогон не трогает чужие данные в Redis и не мешает параллельным прогонам.
 */
export async function createTestApp(db: TestDb): Promise<TestApp> {
  const redis = new Redis(TEST_REDIS_URL, { keyPrefix: `test:${randomBytes(4).toString('hex')}:`, maxRetriesPerRequest: 1 });
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(TEST_CONFIG)
    .overrideProvider(DbService)
    .useValue(db.app)
    .overrideProvider(REDIS)
    .useValue(redis)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  app.enableShutdownHooks();
  await app.listen(0, '127.0.0.1');
  const url = await app.getUrl();
  return {
    app,
    url: url.replace('[::1]', '127.0.0.1'),
    redis,
    async close() {
      // ioredis не добавляет keyPrefix к шаблону KEYS, а к DEL добавляет: шаблон с префиксом, ключи без него.
      const prefix = redis.options.keyPrefix ?? '';
      const keys = await redis.keys(`${prefix}*`);
      if (keys.length > 0) await redis.del(...keys.map((k) => k.slice(prefix.length)));
      await app.close();
    },
  };
}

export interface HttpResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

/** Мини-клиент с cookie: запоминает Set-Cookie и отправляет cookie в следующих запросах. */
export class Client {
  private cookie: string | undefined;

  constructor(private readonly base: string) {}

  async request<T = any>(method: string, path: string, body?: unknown): Promise<HttpResponse<T>> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) {
      const pair = setCookie.split(';')[0]!;
      this.cookie = /Max-Age=0/.test(setCookie) ? undefined : pair;
    }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers };
  }

  get<T = any>(path: string) {
    return this.request<T>('GET', path);
  }
  post<T = any>(path: string, body?: unknown) {
    return this.request<T>('POST', path, body ?? {});
  }
  put<T = any>(path: string, body?: unknown) {
    return this.request<T>('PUT', path, body ?? {});
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.request<T>('PATCH', path, body ?? {});
  }
  delete<T = any>(path: string) {
    return this.request<T>('DELETE', path);
  }

  get hasCookie(): boolean {
    return this.cookie !== undefined;
  }

  /** Копия с той же cookie: проверить, что сервер отзывает сессию, а не только браузер её забывает. */
  clone(): Client {
    const copy = new Client(this.base);
    copy.cookie = this.cookie;
    return copy;
  }
}
