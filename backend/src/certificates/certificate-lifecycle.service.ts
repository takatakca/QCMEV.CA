/**
 * Certificate lifecycle, end to end, on the official layer:
 *   CRT (AJO for a device's first certificate, REM to replace a current one) → both certificates stored →
 *   every SEV user registered again on that device (UTL AJO), so the device can sign at once.
 *
 * Nightly renewal (03:00 America/Montreal): every active SEV certificate expiring within CERT_RENEWAL_DAYS (default 30)
 * is renewed on its own device with CRT REM, signed with the certificate being replaced, so renewal never leaves the
 * device without a working certificate and the device keeps its IDAPPRL and signature chain. One failure never blocks
 * the others; each failure is audited (CRITICAL when the certificate has already expired) and retried the next night.
 *
 * SPEC: the renewal call (REM + noSerie) and how long before expiry Revenu Québec accepts it wait for SW-73.
 */
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { AuditEventType, LogSeverity } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { safeErrorMessage } from '../common/redact';
import { TIME_ZONE } from '../common/time';
import { AuditLogService } from '../logging/audit-log.service';
import { OperatorsService } from '../operators/operators';
import { PrismaService } from '../prisma/prisma.service';
import { CertificateIssued, CertificatesService } from './certificates.service';

export type CertificateReason = 'MANUAL' | 'RENEWAL';

export interface CertificateRequestResult extends CertificateIssued {
  reason: CertificateReason;
  usersRegistered: number;
  usersFailed: number;
}

export interface RenewalRun {
  renewed: Array<{ operatorId: string; deviceId: string; validUntil: Date }>;
  failed: Array<{ operatorId: string; deviceId: string; error: string }>;
}

@Injectable()
export class CertificateLifecycleService {
  private readonly logger = new Logger('CertificateLifecycle');
  private renewalRunning = false;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly certificates: CertificatesService,
    private readonly operators: OperatorsService,
    private readonly audit: AuditLogService,
  ) {}

  get renewalWindowDays(): number {
    return this.cfg.certRenewalDays;
  }

  /**
   * Certificate for one device of the operator: AJO when it has none, REM when it already has an active one.
   * Identity values (NEQ, tax numbers, file number, authorization code) always come from the database, never from a body.
   */
  async requestCertificate(operatorId: string, deviceId: string, reason: CertificateReason = 'MANUAL', nickname?: string): Promise<CertificateRequestResult> {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, operatorId }, select: { id: true } });
    if (!device) throw new NotFoundException('Device not found');
    const renew = await this.certificates.hasActiveCertificate(deviceId);
    const issued = renew
      ? await this.certificates.renewCertificate(operatorId, deviceId, nickname)
      : await this.certificates.requestCertificate(operatorId, deviceId, nickname);
    // Users created before the certificate existed (e.g. the first admin) are registered now.
    const users = await this.operators.syncUsersToDevice(operatorId, deviceId);
    return {
      ...issued,
      reason,
      usersRegistered: users.filter((u) => u.ok).length,
      usersFailed: users.filter((u) => !u.ok).length,
    };
  }

  /** Renews now (REM) the given device, or every certified device of the operator. */
  async renewForOperator(operatorId: string, deviceId?: string): Promise<RenewalRun> {
    const certs = await this.certificates.activeForOperator(operatorId);
    const targets = certs.filter((c) => c.deviceId && (!deviceId || c.deviceId === deviceId));
    if (deviceId && !targets.length) throw new NotFoundException('No active certificate on this device');
    return this.renewAll(targets.map((c) => ({ operatorId, deviceId: c.deviceId as string, validUntil: c.validUntil })));
  }

  /** Nightly job. Also callable directly (tests, manual run). */
  @Cron('0 3 * * *', { name: 'certificate-renewal', timeZone: TIME_ZONE })
  async renewExpiringCertificates(): Promise<RenewalRun> {
    if (this.renewalRunning) {
      this.logger.warn('certificate renewal already running: skipped');
      return { renewed: [], failed: [] };
    }
    this.renewalRunning = true;
    try {
      const expiring = await this.certificates.expiring(null, this.renewalWindowDays);
      if (expiring.length) this.logger.log(`certificate renewal: ${expiring.length} certificate(s) within ${this.renewalWindowDays} days of expiry`);
      return await this.renewAll(expiring.map((c) => ({ operatorId: c.operatorId, deviceId: c.deviceId as string, validUntil: c.validUntil })));
    } finally {
      this.renewalRunning = false;
    }
  }

  private async renewAll(targets: Array<{ operatorId: string; deviceId: string; validUntil: Date | null }>): Promise<RenewalRun> {
    const run: RenewalRun = { renewed: [], failed: [] };
    for (const t of targets) {
      const expired = !!t.validUntil && t.validUntil.getTime() <= Date.now();
      try {
        const r = await this.requestCertificate(t.operatorId, t.deviceId, 'RENEWAL');
        run.renewed.push({ operatorId: t.operatorId, deviceId: t.deviceId, validUntil: r.validUntil });
      } catch (e) {
        const error = safeErrorMessage(e);
        run.failed.push({ operatorId: t.operatorId, deviceId: t.deviceId, error });
        this.logger.error(`certificate renewal failed for device ${t.deviceId}: ${error}`);
        await this.audit.log({
          operatorId: t.operatorId,
          eventType: AuditEventType.MEV_ERROR,
          severity: expired ? LogSeverity.CRITICAL : LogSeverity.ERROR,
          deviceId: t.deviceId,
          entityType: 'Certificate',
          description: `certificate renewal (CRT REM) failed${expired ? ': CERTIFICATE EXPIRED' : ''}: ${error}`,
          metadata: { validUntil: t.validUntil?.toISOString() ?? null },
        });
      }
    }
    return run;
  }
}
