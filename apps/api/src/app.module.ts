import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Redis } from 'ioredis';
import { AccountController } from './accounts/account.controller';
import { AccountSettingsService } from './accounts/account-settings.service';
import { APP_CONFIG, NOTIFIER, OTP_VERIFIER, REDIS } from './app.tokens';
import { StaffAccess } from './auth/access';
import { AuthController } from './auth/auth.controller';
import { SessionGuard } from './auth/auth.guard';
import { AuthService } from './auth/auth.service';
import { SessionStore } from './auth/session-store';
import { UsersService } from './auth/users.service';
import { AvailabilityController } from './availability/availability.controller';
import { AvailabilityService } from './availability/availability.service';
import { BookingsController } from './bookings/bookings.controller';
import { BookingsService } from './bookings/bookings.service';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { ClientsController } from './clients/clients.controller';
import { ClientsService } from './clients/clients.service';
import { CrmService } from './clients/crm.service';
import { loadConfig, type AppConfig } from './config';
import { FieldCipher } from './crypto/field-cipher';
import { EnvKeyProvider } from './crypto/key-provider';
import { PhoneHasher } from './crypto/phone-hash';
import { DbService } from './db/db.service';
import { HealthController } from './health.controller';
import { AppErrorFilter } from './http/error.filter';
import { MaintenanceJobs } from './jobs/maintenance';
import { LogNotifier, type Notifier } from './jobs/notifier';
import { JobScheduler } from './jobs/scheduler';
import { AlphaOtpVerifier, type OtpVerifier } from './public/otp';
import { PublicController } from './public/public.controller';
import { PublicBookingService } from './public/public-booking.service';
import { RateLimiter } from './rate-limit';

/** Закрывает соединение с Redis при остановке приложения (enableShutdownHooks в main.ts). */
@Injectable()
class RedisShutdown implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

@Global()
@Module({
  controllers: [
    HealthController,
    AuthController,
    AccountController,
    CatalogController,
    ClientsController,
    AvailabilityController,
    BookingsController,
    PublicController,
  ],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: APP_FILTER, useClass: AppErrorFilter },
    DbService,
    {
      provide: REDIS,
      useFactory: (config: AppConfig) => new Redis(config.redisUrl, { maxRetriesPerRequest: 2 }),
      inject: [APP_CONFIG],
    },
    RedisShutdown,
    { provide: SessionStore, useFactory: (redis: Redis) => new SessionStore(redis), inject: [REDIS] },
    { provide: RateLimiter, useFactory: (redis: Redis) => new RateLimiter(redis), inject: [REDIS] },
    { provide: PhoneHasher, useFactory: (config: AppConfig) => new PhoneHasher(config.phoneHashPepper), inject: [APP_CONFIG] },
    {
      provide: FieldCipher,
      useFactory: (config: AppConfig) => new FieldCipher(new EnvKeyProvider(config.fieldMasterKey)),
      inject: [APP_CONFIG],
    },
    { provide: OTP_VERIFIER, useFactory: (config: AppConfig) => new AlphaOtpVerifier(config.alphaOtpCode), inject: [APP_CONFIG] },
    SessionGuard,
    { provide: BookingsService, useFactory: (db: DbService) => new BookingsService(db), inject: [DbService] },
    { provide: CatalogService, useFactory: (db: DbService) => new CatalogService(db), inject: [DbService] },
    { provide: StaffAccess, useFactory: (db: DbService) => new StaffAccess(db), inject: [DbService] },
    { provide: NOTIFIER, useFactory: () => new LogNotifier() },
    {
      provide: CrmService,
      useFactory: (db: DbService, clients: ClientsService, hasher: PhoneHasher, cipher: FieldCipher) => new CrmService(db, clients, hasher, cipher),
      inject: [DbService, ClientsService, PhoneHasher, FieldCipher],
    },
    {
      provide: MaintenanceJobs,
      useFactory: (db: DbService, bookings: BookingsService, crm: CrmService, notifier: Notifier) => new MaintenanceJobs(db, bookings, crm, notifier),
      inject: [DbService, BookingsService, CrmService, NOTIFIER],
    },
    {
      // При WORKERS=false фоновые задачи выполняет другой процесс; здесь планировщика нет.
      provide: JobScheduler,
      useFactory: (config: AppConfig, jobs: MaintenanceJobs) =>
        config.workers ? new JobScheduler(jobs, { redisUrl: config.redisUrl, prefix: 'bull' }) : null,
      inject: [APP_CONFIG, MaintenanceJobs],
    },
    { provide: UsersService, useFactory: (db: DbService) => new UsersService(db), inject: [DbService] },
    { provide: AccountSettingsService, useFactory: (db: DbService) => new AccountSettingsService(db), inject: [DbService] },
    { provide: AvailabilityService, useFactory: (db: DbService) => new AvailabilityService(db), inject: [DbService] },
    {
      provide: ClientsService,
      useFactory: (hasher: PhoneHasher, cipher: FieldCipher) => new ClientsService(hasher, cipher),
      inject: [PhoneHasher, FieldCipher],
    },
    {
      provide: AuthService,
      useFactory: (db: DbService, sessions: SessionStore, limiter: RateLimiter) => new AuthService(db, sessions, limiter),
      inject: [DbService, SessionStore, RateLimiter],
    },
    {
      provide: PublicBookingService,
      useFactory: (
        db: DbService,
        catalog: CatalogService,
        availability: AvailabilityService,
        bookings: BookingsService,
        clients: ClientsService,
        hasher: PhoneHasher,
        otp: OtpVerifier,
        limiter: RateLimiter,
      ) => new PublicBookingService(db, catalog, availability, bookings, clients, hasher, otp, limiter),
      inject: [DbService, CatalogService, AvailabilityService, BookingsService, ClientsService, PhoneHasher, OTP_VERIFIER, RateLimiter],
    },
  ],
  exports: [DbService, BookingsService],
})
export class AppModule {}
