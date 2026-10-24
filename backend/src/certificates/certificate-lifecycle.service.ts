/**
 * Certificate Lifecycle Service
 *
 * Orchestrates the MEV-WEB CRT flow (SW-76 §3) end to end:
 *   key pair + CSR → CRT request (signed, real header) → store certificate
 *   → (re)send UTL for users still missing a MEV user id.
 *
 * Also runs the automatic renewal job: every night (Québec time) any active
 * certificate expiring within CERT_RENEWAL_DAYS (default 30) is renewed using
 * the same device. While the old certificate is still valid it signs the CRT
 * request, so renewal never leaves the operator without a working certificate.
 *
 * Lives outside CertificatesService because MevWebService already depends on
 * CertificatesService (signing) — putting this there would be circular.
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AuditEventType, LogSeverity } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CertificatesService } from './certificates.service';
import { MevWebService } from '../mev-web/mev-web.service';
import { AuthService } from '../auth/auth.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MevRequestTypeCode, SectorCode } from '../mev-web/dto/mev-web.dto';
import { MEV_TIMEZONE } from '../mev-web/mev-time';

export interface CertificateRequestResult {
  certificateId:  string;
  identifiantCle: string;
  validTo:        Date;
  deviceId:       string;
  mevUsersSync:   { registered: string[]; failed: string[] };
}

@Injectable()
export class CertificateLifecycleService {
  private readonly logger = new Logger(CertificateLifecycleService.name);
  private renewalRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly certificatesService: CertificatesService,
    private readonly mevWebService: MevWebService,
    private readonly authService: AuthService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** Days before validTo at which renewal starts (env CERT_RENEWAL_DAYS, default 30) */
  get renewalWindowDays(): number {
    const n = Number(process.env.CERT_RENEWAL_DAYS ?? 30);
    return Number.isFinite(n) && n > 0 ? n : 30;
  }

  /**
   * Request (or renew) the operator certificate for one of its devices.
   * NEQ, authorization code and sector always come from the Operator record —
   * never from the client request body.
   */
  async requestCertificate(
    operatorId: string,
    deviceId: string,
    reason: 'INITIAL' | 'RENEWAL' | 'MANUAL' = 'MANUAL',
  ): Promise<CertificateRequestResult> {
    if (!deviceId) throw new BadRequestException('deviceId is required');

    const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!operator) throw new NotFoundException('Operator not found');

    const device = await this.prisma.device.findFirst({ where: { id: deviceId, operatorId } });
    if (!device) throw new NotFoundException('Device not found for this operator');
    if (!device.isActive) throw new BadRequestException('Device is inactive');

    await this.auditLog.log({
      operatorId,
      eventType:   AuditEventType.CERTIFICATE_REQUESTED,
      severity:    LogSeverity.INFO,
      deviceId,
      entityType:  'Certificate',
      description: `Demande de certificat (${reason}) pour l'appareil ${device.serialNumber}`,
    });

    const { csrPem, encryptedPrivateKey } =
      await this.certificatesService.generateKeyPairAndCSR(operatorId, deviceId);

    const response = await this.mevWebService.submitCertificateRequest(operatorId, {
      entete: this.mevWebService.buildHeader(operator, MevRequestTypeCode.CRT, {
        numeroAppareil: device.id,
      }),
      corps: {
        neq:              operator.neq,
        codeAutorisation: operator.authorizationCode ?? '',
        secteur:          operator.sector as unknown as SectorCode,
        csrPem,
      },
    });

    if (!response?.certificatPem || !response?.identifiantCle) {
      throw new Error(`MEV-WEB CRT response incomplete (codeRetour ${response?.codeRetour ?? '?'})`);
    }

    const stored = await this.certificatesService.storeMevWebCertificate(
      operatorId,
      response.certificatPem,
      encryptedPrivateKey,
      response.identifiantCle,
      deviceId,
    );

    await this.auditLog.log({
      operatorId,
      eventType:   AuditEventType.CERTIFICATE_RECEIVED,
      severity:    LogSeverity.INFO,
      deviceId,
      entityId:    stored.id,
      entityType:  'Certificate',
      description: `Certificat reçu (${reason}) — clé ${response.identifiantCle}, valide jusqu'au ${stored.validTo.toISOString().slice(0, 10)}`,
      metadata:    { identifiantCle: response.identifiantCle, validTo: stored.validTo.toISOString(), reason },
    });

    // Users created before the certificate existed (e.g. the first admin) get their UTL now
    const mevUsersSync = await this.authService.syncMevUsers(operatorId);

    return {
      certificateId:  stored.id,
      identifiantCle: response.identifiantCle,
      validTo:        stored.validTo,
      deviceId,
      mevUsersSync,
    };
  }

  /** Renew one operator's active certificate on the same device (fallback: first active device). */
  async renewForOperator(operatorId: string): Promise<CertificateRequestResult> {
    const current = await this.certificatesService.getActiveCertRecord(operatorId);
    let deviceId = current?.deviceId ?? null;
    if (!deviceId) {
      const device = await this.prisma.device.findFirst({
        where:   { operatorId, isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      deviceId = device?.id ?? null;
    }
    if (!deviceId) throw new BadRequestException('No active device to renew the certificate with');
    return this.requestCertificate(operatorId, deviceId, 'RENEWAL');
  }

  /**
   * Nightly renewal job (03:00 Québec time). Renews every active certificate
   * expiring within the renewal window. One failure never blocks the others;
   * each failure is audited and retried the next night.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'certificate-renewal', timeZone: MEV_TIMEZONE })
  async renewExpiringCertificates(): Promise<{ renewed: string[]; failed: Array<{ operatorId: string; error: string }> }> {
    const renewed: string[] = [];
    const failed: Array<{ operatorId: string; error: string }> = [];
    if (this.renewalRunning) {
      this.logger.warn('Certificate renewal already running — skipped');
      return { renewed, failed };
    }
    this.renewalRunning = true;

    try {
      const expiring = await this.certificatesService.getExpiringCertificates(this.renewalWindowDays);
      const operatorIds = [...new Set(expiring.map(c => c.operatorId))];
      if (operatorIds.length) {
        this.logger.log(`Certificate renewal: ${operatorIds.length} operator(s) within ${this.renewalWindowDays} days of expiry`);
      }

      for (const operatorId of operatorIds) {
        const cert = expiring.find(c => c.operatorId === operatorId);
        const expired = !!cert?.validTo && cert.validTo.getTime() <= Date.now();
        try {
          await this.renewForOperator(operatorId);
          renewed.push(operatorId);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          failed.push({ operatorId, error });
          this.logger.error(`Certificate renewal failed for operator ${operatorId}: ${error}`);
          await this.auditLog.log({
            operatorId,
            eventType:   AuditEventType.MEV_SUBMISSION_FAILED,
            severity:    expired ? LogSeverity.CRITICAL : LogSeverity.ERROR,
            entityId:    cert?.id,
            entityType:  'Certificate',
            description: `Renouvellement du certificat échoué${expired ? ' — CERTIFICAT EXPIRÉ' : ''}: ${error}`,
            metadata:    { validTo: cert?.validTo?.toISOString() ?? null, error },
          });
        }
      }
    } finally {
      this.renewalRunning = false;
    }
    return { renewed, failed };
  }
}
