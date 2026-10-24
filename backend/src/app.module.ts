/**
 * Root module. Built from the validated AppConfig so that what is mounted depends on the environment:
 *  - the simulator only in SIMULATOR / DEV;
 *  - the Food Hub integration only when QCMEV_FOODHUB_ENABLED=true.
 */
import { HttpModule } from '@nestjs/axios';
import { Controller, DynamicModule, ExecutionContext, Get, Inject, Injectable, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_CONFIG, AppConfig } from './config/app-config';
import { ApiErrorFilter } from './common/errors.filter';
import { KEY_VAULT, KeyVault } from './crypto/key-vault';
import { AuthController, AuthService, JwtStrategy } from './auth/auth';
import { CertificatesService } from './certificates/certificates.service';
import { CertificatesController, DevicesController, DevicesService } from './devices/devices';
import { FoodHubController } from './integrations/foodhub/foodhub.controller';
import { FoodHubSignatureGuard } from './integrations/foodhub/foodhub.guard';
import { FoodHubService } from './integrations/foodhub/foodhub.service';
import { AuditLogService } from './logging/audit-log.service';
import { MevWebService } from './mev-web/mev-web.service';
import { OfflineWatchService } from './offline/offline-watch.service';
import { OperatorsController, OperatorsService } from './operators/operators';
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

  protected async shouldSkip(ctx: ExecutionContext): Promise<boolean> {
    return super.shouldSkip(ctx);
  }
}

@SkipThrottle()
@Controller('health')
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  /** Liveness only: no data, no identity. */
  @Get()
  health() {
    return { status: 'ok', service: 'takatak-mev', environment: this.cfg.mevEnvironment, certified: this.cfg.certified };
  }
}

@Module({})
export class AppModule {
  static forRoot(cfg: AppConfig): DynamicModule {
    const controllers: DynamicModule['controllers'] = [
      HealthController,
      AuthController,
      OperatorsController,
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
      TransactionsService,
      ReceiptService,
      OperatorsService,
      DevicesService,
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
        JwtModule.register({ secret: cfg.jwtSecret, signOptions: { expiresIn: cfg.jwtExpiresIn } }),
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
      ],
      controllers,
      providers,
    };
  }
}
