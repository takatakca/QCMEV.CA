/**
 * Takatak MEV — NestJS Application Bootstrap
 *
 * Starts the MEV-WEB SEV backend API.
 * Default port: 3001 (frontend proxy configured to this port)
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { MevWebErrorFilter } from './mev-web/mev-error.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { logger: ['log', 'error', 'warn', 'debug'] });

  // CORS — allow Next.js frontend dev server
  app.enableCors({
    origin: [
      'http://localhost:3000',
      process.env.FRONTEND_URL ?? 'http://localhost:3000',
    ],
    credentials: true,
  });

  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist:        true,
      forbidNonWhitelisted: false,
      transform:        true,
    }),
  );

  app.useGlobalFilters(new MevWebErrorFilter());

  // Global prefix
  app.setGlobalPrefix('api');

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`🚀 Takatak MEV API running on http://localhost:${port}/api`);
  logger.log(`🔵 MEV Simulator at http://localhost:${port}/api/mev-simulator`);
  logger.log(`📋 Environment: ${process.env.NODE_ENV ?? 'development'}`);
}

bootstrap();
