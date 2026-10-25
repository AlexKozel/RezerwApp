import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { dedupeKey, type BookingNotification, type Notifier } from '../jobs/notifier';

export const NOTIFICATIONS_QUEUE = 'notifications';

/**
 * Notifier по умолчанию: ставит событие в очередь BullMQ (D-030, D-052). jobId = ключ события, поэтому
 * повторная постановка того же события, пока задача в очереди, не создаёт дубль. Повторы с нарастающей
 * задержкой: каналы и провайдеры бывают недоступны.
 */
export class QueueNotifier implements Notifier {
  private queue?: Queue;
  private redis?: Redis;

  constructor(
    private readonly redisUrl: string,
    private readonly prefix: string,
  ) {}

  async notify(event: BookingNotification): Promise<void> {
    if (!this.queue) {
      this.redis = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
      this.queue = new Queue(NOTIFICATIONS_QUEUE, { connection: this.redis, prefix: this.prefix });
    }
    // BullMQ не допускает «:» в jobId.
    await this.queue.add(event.type, event, {
      jobId: dedupeKey(event).replace(/:/g, '_'),
      attempts: 6,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
      removeOnFail: 1000,
    });
  }

  /** Nest вызывает при остановке приложения (enableShutdownHooks). */
  onApplicationShutdown(): Promise<void> {
    return this.close();
  }

  async close(): Promise<void> {
    await this.queue?.close();
    await this.redis?.quit().catch(() => undefined);
  }
}
