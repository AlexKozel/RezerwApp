import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { Db, createPool } from './db';

/** Db для Nest-приложения. Подключается ролью приложения (DATABASE_URL), не мигратором. */
@Injectable()
export class DbService extends Db implements OnApplicationShutdown {
  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    super(createPool(url));
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
