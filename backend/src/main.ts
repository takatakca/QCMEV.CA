/**
 * Takatak MEV backend. Not certified by Revenu Québec: SIMULATOR / DEV only until certification.
 * The configuration is read and validated BEFORE Nest starts; a missing or weak secret stops the start.
 */
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ConfigError, loadConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // no .env file: the environment is used as is
  }
  let cfg;
  try {
    cfg = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      // eslint-disable-next-line no-console
      console.error(`Configuration refused: ${e.message}`);
      process.exit(78);
    }
    throw e;
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), { rawBody: true, logger: cfg.logLevels, bodyParser: true });
  app.useBodyParser('json', { limit: '256kb' });
  app.enableCors({ origin: cfg.frontendOrigins, credentials: false });
  app.useGlobalPipes(new ValidationPipe({ transform: false, whitelist: false }));
  app.setGlobalPrefix('api');
  app.enableShutdownHooks();
  const http = app.getHttpAdapter().getInstance();
  http.disable('x-powered-by');
  http.set('trust proxy', 'loopback, linklocal, uniquelocal');
  await app.listen(cfg.port, '0.0.0.0');
  const log = new Logger('Bootstrap');
  log.log(`Takatak MEV API on port ${cfg.port} (MEV_ENVIRONMENT=${cfg.mevEnvironment}, certified=${cfg.certified})`);
  if (cfg.simulatorEnabled) log.log('Local simulator mounted at /api/mev-simulator (test double, not Revenu Québec)');
  log.log(`Food Hub integration ${cfg.foodhub.enabled ? 'ENABLED at /api/v1/integrations/foodhub' : 'disabled (QCMEV_FOODHUB_ENABLED=false)'}`);
}

void bootstrap();
