/**
 * App Module
 *
 * Root NestJS module wiring all feature modules together.
 * Takatak MEV — Revenu Québec MEV-WEB SEV Integration
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';

// Core
import { PrismaService } from './prisma/prisma.service';

// Auth
import { AuthService } from './auth/auth.service';
import { AuthController } from './auth/auth.controller';
import { JwtStrategy } from './auth/jwt.strategy';

// Logging
import { AuditLogService } from './logging/audit-log.service';

// MEV-WEB
import { MevWebService } from './mev-web/mev-web.service';
import { MevSimulatorService } from './mev-web/mev-simulator.service';
import { MevSimulatorController } from './mev-web/mev-simulator.service';

// Certificates
import { CertificatesService } from './certificates/certificates.service';
import { CertificatesController } from './certificates/certificates.controller';
import { CertificateLifecycleService } from './certificates/certificate-lifecycle.service';

// Transactions
import { TransactionsService } from './transactions/transactions.service';
import { TransactionsController } from './transactions/transactions.controller';

// Receipts
import { ReceiptService } from './documents/receipt.service';
import { PublicReceiptController } from './documents/public-receipt.controller';

// Operators
import { OperatorsService } from './operators/operators.service';
import { OperatorsController } from './operators/operators.controller';

// Devices
import { DevicesService } from './devices/devices.service';
import { DevicesController } from './devices/devices.controller';

// Offline queue
import { OfflineQueueService } from './offline/offline-queue.service';

// Partner API (Clover app, Food Hub)
import { PartnerService } from './partner/partner.service';
import { PartnerController } from './partner/partner.controller';
import { PartnerKeysController } from './partner/partner-keys.controller';
import { ApiKeyGuard } from './partner/api-key.guard';

// Reports
import { ReportsService } from './reports/reports.service';
import { ReportsController } from './reports/reports.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    HttpModule,
    PassportModule,
    JwtModule.register({
      secret:      process.env.JWT_SECRET ?? 'takatak-mev-dev-secret-CHANGE-IN-PROD',
      signOptions: { expiresIn: process.env.JWT_EXPIRES_IN ?? '8h' },
    }),
  ],
  controllers: [
    AuthController,
    CertificatesController,
    TransactionsController,
    OperatorsController,
    DevicesController,
    ReportsController,
    MevSimulatorController,
    PartnerController,
    PublicReceiptController,
    PartnerKeysController,
  ],
  providers: [
    PrismaService,
    AuditLogService,
    AuthService,
    JwtStrategy,
    MevWebService,
    MevSimulatorService,
    CertificatesService,
    CertificateLifecycleService,
    TransactionsService,
    ReceiptService,
    OperatorsService,
    DevicesService,
    OfflineQueueService,
    ReportsService,
    PartnerService,
    ApiKeyGuard,
  ],
})
export class AppModule {}
