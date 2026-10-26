/**
 * HTTP set-up shared by the server (main.ts) and the database integration suite (test/sw77): body size, CORS,
 * validation (class-validator DTOs: unknown fields stripped, bad bodies answer 400), the /api prefix, proxy trust.
 */
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AppConfig } from './config/app-config';

export function configureApp(app: NestExpressApplication, cfg: AppConfig): void {
  app.useBodyParser('json', { limit: '256kb' });
  app.enableCors({ origin: cfg.frontendOrigins, credentials: false });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: false, transform: true }));
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', 'loopback, linklocal, uniquelocal');
}
