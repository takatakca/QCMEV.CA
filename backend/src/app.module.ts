/**
 * Root module. Built from the validated AppConfig so that what is mounted depends on the environment:
 *  - the simulator only in SIMULATOR / DEV;
 *  - the Food Hub integration only when QCMEV_FOODHUB_ENABLED=true.
 * Global rate limit (two tiers, per client IP; per tenant on the Food Hub routes) and the nightly certificate renewal
 * job (ScheduleModule) are always on.
 */
import { HttpModule } from '@nestjs/axios';
import { Controller, DynamicModule, Get, Inject, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { ApiErrorFilter } from './common/errors.filter';
import { SKIP_ALL_THROTTLES } from './common/throttle';
import { KEY_VAULT, KeyVault } from './crypto/key-vault';
import { AuthController, AuthService, JwtStrategy } from './auth/auth';
import { CertificateLifecycleService } from './certificates/certificate-lifecycle.service';
import { CertificatesService } from './certificates/certificates.service';
import { CertificatesController, DevicesController, DevicesService } from './devices/devices';
import { FoodHubController } from './integrations/foodhub/foodhub.controller';
import { FoodHubLocationsController, FoodHubLocationsService } from './integrations/foodhub/foodhub-locations';
import { FoodHubSignatureGuard } from './integrations/foodhub/foodhub.guard';
import { FoodHubService } from './integrations/foodhub/foodhub.service';
import { AuditLogService } from './logging/audit-log.service';
import { MevWebService } from './mev-web/mev-web.service';
import { OfflineWatchService } from './offline/offline-watch.service';
import { OperatorRegistrationController, OperatorsController, OperatorsService } from './operators/operators';
import { PrismaService } from './prisma/prisma.service';
import { ReceiptService } from './receipts/receipt.service';
import { ReportsController, ReportsService } from './reports/reports';
import { MevSimulatorController } from './simulator/mev-simulator.controller';
import { MevSimulatorService } from './simulator/mev-simulator.service';
import { TransactionsController } from './transactions/transactions.controller';
import { TransactionsService } from './transactions/transactions.service';

/** Rate limit per tenant for the Food Hub routes, per IP elsewhere. */
@Injectable()
export class TenantThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = (req.headers ?? {}) as Record<string, string | undefined>;
    const url = String(req.url ?? '');
    if (url.includes('/integrations/foodhub') && headers['x-tenant-id']) return `tenant:${headers['x-tenant-id']}`;
    return String(req.ip ?? 'unknown');
  }
}

@SkipThrottle(SKIP_ALL_THROTTLES)
@Controller('health')
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig, private readonly prisma: PrismaService) {}

  /** Liveness only: no data, no identity. */
  @Get()
  health() {
    return { status: 'ok', service: 'takatak-mev', environment: this.cfg.mevEnvironment, certified: this.cfg.certified };
  }

  /** Readiness is distinct from liveness: a running process with an unavailable database must not receive traffic. */
  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ statusCode: 503, status: 'not_ready', database: 'unavailable' });
    }
    return { ...this.health(), database: 'ready' };
  }
}

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    const controllers: DynamicModule['controllers'] = [
      HealthController,
      AuthController,
      OperatorRegistrationController,
      OperatorsController,
      // Staff setup of the Food Hub locations: always mounted (the signed Food Hub API is not).
      FoodHubLocationsController,
      DevicesController,
      CertificatesController,
      TransactionsController,
      ReportsController,
    ];
    const providers: DynamicModule['providers'] = [
      { provide: APP_CONFIG, useValue: cfg },
      { provide: KEY_VAULT, useValue: new KeyVault(cfg.keyEncryptionKey) },
      { provide: APP_GUARD, useClass: TenantThrottlerGuard },
      { provide: APP_FILTER, useClass: ApiErrorFilter },
      PrismaService,
      AuditLogService,
      AuthService,
      JwtStrategy,
      MevWebService,
      CertificatesService,
      CertificateLifecycleService,
      TransactionsService,
      ReceiptService,
      OperatorsService,
      DevicesService,
      FoodHubLocationsService,
      ReportsService,
      OfflineWatchService,
    ];
    if (cfg.simulatorEnabled) {
      controllers.push(MevSimulatorController);
      providers.push(MevSimulatorService);
    }
    if (cfg.foodhub.enabled) {
      controllers.push(FoodHubController);
      providers.push(FoodHubService, FoodHubSignatureGuard);
    }
    return {
      module: AppModule,
      imports: [
        HttpModule.register({ maxRedirects: 0 }),
        PassportModule,
        ScheduleModule.forRoot(),
        JwtModule.register({ secret: cfg.jwtSecret, signOptions: { expiresIn: cfg.jwtExpiresIn } }),
        ThrottlerModule.forRoot([
          { name: 'short', ttl: 1_000, limit: cfg.rateLimit.perSecond },
          { name: 'medium', ttl: 60_000, limit: cfg.rateLimit.perMinute },
        ]),
      ],
      controllers,
      providers,
    };
  }
}
