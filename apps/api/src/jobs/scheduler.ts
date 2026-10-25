import { Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import type { NotificationDispatcher } from '../notifications/dispatcher';
import { NOTIFICATIONS_QUEUE } from '../notifications/queue';
import type { MaintenanceJobs } from './maintenance';
import type { BookingNotification } from './notifier';

export const MAINTENANCE_QUEUE = 'maintenance';
export const MAINTENANCE_EVERY_MS = 60_000;

export interface SchedulerOptions {
  redisUrl: string;
  /** Префикс ключей BullMQ в Redis (в тестах уникальный на прогон). */
  prefix: string;
  everyMs?: number;
}

/**
 * Очередь BullMQ (D-030) с повторяющейся задачей обслуживания. Расписание хранится в Redis
 * (upsertJobScheduler), поэтому при нескольких экземплярах API задача выполняется один раз за интервал,
 * а не в каждом процессе. Воркер обрабатывает по одной задаче за раз.
 */
export class JobScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('JobScheduler');
  private queue?: Queue;
  private worker?: Worker;
  private notificationsWorker?: Worker;
  private connections: Redis[] = [];

  constructor(
    private readonly jobs: MaintenanceJobs,
    private readonly options: SchedulerOptions,
    /** Доставка уведомлений из очереди notifications (D-052); без него воркер уведомлений не запускается. */
    private readonly dispatcher?: NotificationDispatcher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // BullMQ требует maxRetriesPerRequest: null; воркеру нужно отдельное (блокирующее) соединение.
    const connect = () => {
      const redis = new Redis(this.options.redisUrl, { maxRetriesPerRequest: null });
      this.connections.push(redis);
      return redis;
    };
    this.queue = new Queue(MAINTENANCE_QUEUE, { connection: connect(), prefix: this.options.prefix });
    await this.queue.upsertJobScheduler(
      'maintenance-tick',
      { every: this.options.everyMs ?? MAINTENANCE_EVERY_MS },
      { name: 'tick', opts: { removeOnComplete: 100, removeOnFail: 100 } },
    );
    this.worker = new Worker(MAINTENANCE_QUEUE, () => this.jobs.run(), {
      connection: connect(),
      prefix: this.options.prefix,
      concurrency: 1,
    });
    this.worker.on('failed', (_job, error) => this.logger.error(`maintenance failed: ${error.message}`));

    const dispatcher = this.dispatcher;
    if (dispatcher) {
      this.notificationsWorker = new Worker(NOTIFICATIONS_QUEUE, (job) => dispatcher.dispatch(job.data as BookingNotification), {
        connection: connect(),
        prefix: this.options.prefix,
        concurrency: 5,
      });
      this.notificationsWorker.on('failed', (job, error) =>
        this.logger.warn(`notification ${job?.id} attempt ${job?.attemptsMade}: ${error.message}`),
      );
    }
    this.worker.on('completed', (_job, r: { expired: number; reminded: number; blacklistPurged: number }) => {
      if (r.expired + r.reminded + r.blacklistPurged > 0) {
        this.logger.log(`expired=${r.expired} reminded=${r.reminded} blacklistPurged=${r.blacklistPurged}`);
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.notificationsWorker?.close();
    await this.worker?.close();
    await this.queue?.close();
    await Promise.all(this.connections.map((c) => c.quit().catch(() => undefined)));
  }

  /** Для тестов: дождаться завершения следующей задачи. */
  nextCompleted(): Promise<unknown> {
    return new Promise((resolve) => this.worker?.once('completed', (_job, result) => resolve(result)));
  }
}
