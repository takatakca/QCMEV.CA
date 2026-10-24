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
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

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

// Operators
import { OperatorsService } from './operators/operators.service';
import { OperatorsController } from './operators/operators.controller';

// Devices
import { DevicesService } from './devices/devices.service';
import { DevicesController } from './devices/devices.controller';

// Offline queue
import { OfflineQueueService } from './offline/offline-queue.service';

// Reports
import { ReportsService } from './reports/reports.service';
import { ReportsController } from './reports/reports.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    HttpModule,
    PassportModule,
    ThrottlerModule.forRoot([
      {
        name:  'short',
        ttl:   1_000,   // 1 s
        limit: 10,      // max 10 requests/s per IP
      },
      {
        name:  'medium',
        ttl:   60_000,  // 1 min
        limit: 100,     // max 100 requests/min per IP
      },
    ]),
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
  ],
  providers: [
    // Global rate-limit guard (applies to every route)
    { provide: APP_GUARD, useClass: ThrottlerGuard },
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
  ],
})
export class AppModule {}
