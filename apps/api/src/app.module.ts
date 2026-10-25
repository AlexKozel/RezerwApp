import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Redis } from 'ioredis';
import { AccountController } from './accounts/account.controller';
import { AccountSettingsService } from './accounts/account-settings.service';
import { AnalyticsController } from './analytics/analytics.controller';
import { AnalyticsService } from './analytics/analytics.service';
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
import { LegalController } from './legal/legal.controller';
import { LegalService } from './legal/legal.service';
import { LocationsController } from './locations/locations.controller';
import { InviteTokens, LocationsService } from './locations/locations.service';
import type { Notifier } from './jobs/notifier';
import { JobScheduler } from './jobs/scheduler';
import { SandboxChannel } from './notifications/channels';
import { NotificationDispatcher } from './notifications/dispatcher';
import { QueueNotifier } from './notifications/queue';
import { ManageBookingService } from './public/manage-booking.service';
import { ManageTokens } from './public/manage-token';
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
    LocationsController,
    LegalController,
    AnalyticsController,
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
    {
      provide: BookingsService,
      useFactory: (db: DbService, notifier: Notifier) => new BookingsService(db, notifier),
      inject: [DbService, NOTIFIER],
    },
    { provide: CatalogService, useFactory: (db: DbService) => new CatalogService(db), inject: [DbService] },
    { provide: StaffAccess, useFactory: (db: DbService) => new StaffAccess(db), inject: [DbService] },
    // Уведомления ставятся в очередь BullMQ (D-052); доставляет воркер JobScheduler.
    { provide: NOTIFIER, useFactory: (config: AppConfig) => new QueueNotifier(config.redisUrl, 'bull'), inject: [APP_CONFIG] },
    {
      provide: NotificationDispatcher,
      useFactory: (db: DbService, cipher: FieldCipher, tokens: ManageTokens, config: AppConfig, notifier: Notifier) =>
        // Провайдеров пока нет: email и SMS в песочнице, push и мессенджеры появятся с подписками клиентов.
        new NotificationDispatcher(db, cipher, tokens, [new SandboxChannel('email'), new SandboxChannel('sms')], config.publicUrl, notifier),
      inject: [DbService, FieldCipher, ManageTokens, APP_CONFIG, NOTIFIER],
    },
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
      useFactory: (config: AppConfig, jobs: MaintenanceJobs, dispatcher: NotificationDispatcher) =>
        config.workers ? new JobScheduler(jobs, { redisUrl: config.redisUrl, prefix: 'bull' }, dispatcher) : null,
      inject: [APP_CONFIG, MaintenanceJobs, NotificationDispatcher],
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
        tokens: ManageTokens,
        notifier: Notifier,
      ) => new PublicBookingService(db, catalog, availability, bookings, clients, hasher, otp, limiter, tokens, notifier),
      inject: [
        DbService,
        CatalogService,
        AvailabilityService,
        BookingsService,
        ClientsService,
        PhoneHasher,
        OTP_VERIFIER,
        RateLimiter,
        ManageTokens,
        NOTIFIER,
      ],
    },
    { provide: ManageTokens, useFactory: (config: AppConfig) => new ManageTokens(config.fieldMasterKey), inject: [APP_CONFIG] },
    { provide: AnalyticsService, useFactory: (db: DbService) => new AnalyticsService(db), inject: [DbService] },
    {
      provide: LegalService,
      useFactory: (db: DbService, hasher: PhoneHasher) => new LegalService(db, hasher),
      inject: [DbService, PhoneHasher],
    },
    {
      provide: LocationsService,
      useFactory: (db: DbService, config: AppConfig) => new LocationsService(db, new InviteTokens(config.fieldMasterKey)),
      inject: [DbService, APP_CONFIG],
    },
    {
      provide: ManageBookingService,
      useFactory: (
        db: DbService,
        availability: AvailabilityService,
        bookings: BookingsService,
        tokens: ManageTokens,
        limiter: RateLimiter,
        notifier: Notifier,
      ) => new ManageBookingService(db, availability, bookings, tokens, limiter, notifier),
      inject: [DbService, AvailabilityService, BookingsService, ManageTokens, RateLimiter, NOTIFIER],
    },
  ],
  exports: [DbService, BookingsService],
})
export class AppModule {}
