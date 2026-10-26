/**
 * Takatak MEV backend. Not certified by Revenu Québec: SIMULATOR / DEV / ESSAI only until certification.
 * The configuration is read and validated BEFORE Nest starts; a missing or weak secret stops the start.
 */
import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { AppConfig, ConfigError, loadConfig } from './config/app-config';

async function bootstrap(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    // no .env file: the environment is used as is
  }
  let cfg: AppConfig;
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
  configureApp(app, cfg);
  await app.listen(cfg.port, '0.0.0.0');
  const log = new Logger('Bootstrap');
  log.log(`Takatak MEV API on port ${cfg.port} (MEV_ENVIRONMENT=${cfg.mevEnvironment}, certified=${cfg.certified})`);
  if (cfg.simulatorEnabled) log.log('Local simulator mounted at /api/mev-simulator (test double, not Revenu Québec)');
  log.log(`Food Hub integration ${cfg.foodhub.enabled ? 'ENABLED at /api/v1/integrations/foodhub' : 'disabled (QCMEV_FOODHUB_ENABLED=false)'}`);
  log.log(`Operator self-registration ${cfg.publicRegistration ? 'open (POST /api/operators/register)' : 'closed (QCMEV_PUBLIC_REGISTRATION=false)'}`);
}

void bootstrap();
