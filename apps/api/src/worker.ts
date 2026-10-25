import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

/**
 * Фоновые задачи без HTTP: для развёртывания, где API запущен с WORKERS=false, а задачи в отдельном процессе.
 * В alpha достаточно одного процесса API (WORKERS по умолчанию включены).
 */
async function bootstrap(): Promise<void> {
  if (process.env.WORKERS === 'false') throw new Error('worker process started with WORKERS=false');
  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
}

void bootstrap();
