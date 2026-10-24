import { Global, Module } from '@nestjs/common';
import { BookingsService } from './bookings/bookings.service';
import { DbService } from './db/db.service';
import { HealthController } from './health.controller';

@Global()
@Module({
  controllers: [HealthController],
  providers: [DbService, { provide: BookingsService, useFactory: (db: DbService) => new BookingsService(db), inject: [DbService] }],
  exports: [DbService, BookingsService],
})
export class AppModule {}
