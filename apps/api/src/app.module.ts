import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Redis } from 'ioredis';
import { AccountController } from './accounts/account.controller';
import { AccountSettingsService } from './accounts/account-settings.service';
import { APP_CONFIG, OTP_VERIFIER, REDIS } from './app.tokens';
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
import { ClientsService } from './clients/clients.service';
import { loadConfig, type AppConfig } from './config';
import { FieldCipher } from './crypto/field-cipher';
import { EnvKeyProvider } from './crypto/key-provider';
import { PhoneHasher } from './crypto/phone-hash';
import { DbService } from './db/db.service';
import { HealthController } from './health.controller';
import { AppErrorFilter } from './http/error.filter';
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
