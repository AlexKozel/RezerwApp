import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DbService } from './db/db.service';

@Controller('health')
export class HealthController {
  constructor(private readonly db: DbService) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await this.db.pool.query('SELECT 1');
    } catch {
      throw new ServiceUnavailableException({ status: 'database_unavailable' });
    }
    return { status: 'ok' };
  }
}
