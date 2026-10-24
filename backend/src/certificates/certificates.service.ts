/**
 * SEV certificates (CRT): ECDSA P-256 key pair + CSR, request to MEV-WEB, storage of the SEV certificate
 * (private key AES-256-GCM encrypted) and of MEV-WEB's certificate, IDAPPRL saved on the device.
 *
 * The decrypted private key is never cached: it is decrypted for each signature and dropped.
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { AuditEventType, CertificateType, LogSeverity } from '@prisma/client';
import * as crypto from 'crypto';
import { civilTime } from '../common/time';
import { certThumbprint } from '../crypto/ecdsa';
import { csrBody, generateKeyAndCsr } from '../crypto/csr';
import { KEY_VAULT, KeyVault } from '../crypto/key-vault';
import { AuditLogService } from '../logging/audit-log.service';
import { classifyErrors } from '../mev-web/mev-web.types';
import { MevWebService, SigningMaterial } from '../mev-web/mev-web.service';
import { PrismaService } from '../prisma/prisma.service';

export interface DeviceReadiness {
  deviceReady: boolean;
  certReady: boolean;
  certificateValidUntil: Date | null;
}

export interface CertificateIssued {
  status: 'issued' | 'renewed';
  modif: 'AJO' | 'REM';
  deviceId: string;
  mevDeviceId: string;
  serialNumber: string;
  validFrom: Date;
  validUntil: Date;
}

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger('Certificates');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mevWeb: MevWebService,
    private readonly audit: AuditLogService,
    @Inject(KEY_VAULT) private readonly vault: KeyVault,
  ) {}

  /** CRT AJO: the device's first certificate (new key pair + CSR), both certificates and the IDAPPRL stored. */
  async requestCertificate(operatorId: string, deviceId: string, nickname?: string): Promise<CertificateIssued> {
    return this.enrol(operatorId, deviceId, 'AJO', nickname);
  }

  /**
   * CRT REM: replaces the device's current certificate (renewal). A new key pair and CSR; the request carries the
   * noSerie of the certificate being replaced and is signed with its key, so the device keeps its IDAPPRL, its users
   * and its signature chain. SPEC: REM / noSerie (S1) and the renewal rules wait for SW-73.
   */
  async renewCertificate(operatorId: string, deviceId: string, nickname?: string): Promise<CertificateIssued> {
    return this.enrol(operatorId, deviceId, 'REM', nickname);
  }

  /** true when the device already has an active SEV certificate and an IDAPPRL (a new request is then a renewal). */
  async hasActiveCertificate(deviceId: string): Promise<boolean> {
    const [device, cert] = await Promise.all([
      this.prisma.device.findUnique({ where: { id: deviceId }, select: { mevDeviceId: true } }),
      this.prisma.certificate.findFirst({ where: { deviceId, type: CertificateType.SEV, isActive: true }, select: { id: true } }),
    ]);
    return !!device?.mevDeviceId && !!cert;
  }

  private async enrol(operatorId: string, deviceId: string, modif: 'AJO' | 'REM', nickname?: string): Promise<CertificateIssued> {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, operatorId }, include: { operator: true } });
    if (!device) throw new NotFoundException('Device not found');
    if (!device.isActive) throw new BadRequestException('Device is inactive');
    if (!device.fileNumber || !device.authorizationCodeEnc) {
      throw new BadRequestException('The device needs its file number and authorization code first (PUT /api/devices/:id or seed:operator)');
    }
    let signer: SigningMaterial | undefined;
    let noSerie: string | undefined;
    if (modif === 'REM') {
      const current = await this.prisma.certificate.findFirst({ where: { deviceId, type: CertificateType.SEV, isActive: true }, orderBy: { createdAt: 'desc' } });
      if (!current?.serialNumber || !device.mevDeviceId) throw new BadRequestException('Nothing to renew: the device has no active certificate (run CRT first)');
      signer = await this.signingMaterial(deviceId);
      noSerie = current.serialNumber;
    }
    const authorizationCode = this.vault.decrypt(device.authorizationCodeEnc, `auth:${device.id}`);
    const op = device.operator;
    const nick = (nickname ?? `Certificat ${device.serialNumber}`).slice(0, 32).padEnd(8, '0');
    const { csrPem, privateKeyPem } = await generateKeyAndCsr({
      utcOffset: civilTime().utc,
      nickname: nick,
      sector: op.sector,
      authorizationCode,
      noTVQ: op.noTVQ,
      neq: op.neq,
      fileNumber: device.fileNumber,
    });

    await this.audit.log({ operatorId, eventType: AuditEventType.CERTIFICATE_REQUESTED, deviceId, description: `CRT ${modif} for device ${device.serialNumber}` });
    const res = await this.mevWeb.certificateRequest({ id: op.id, noTPS: op.noTPS, noTVQ: op.noTVQ }, authorizationCode, modif, csrBody(csrPem), noSerie, signer);
    const r = res?.retourCertif ?? {};
    // REM keeps the device's IDAPPRL when the answer does not repeat it (SPEC).
    const idApprl = r.idApprl ?? (modif === 'REM' ? device.mevDeviceId : undefined);
    // SW-76 §4.2.1: the first answer carries two certificates (ours, and MEV-WEB's for the QR code); both are required.
    if (classifyErrors(r.listErr) !== 'accepted' || !r.certif || !idApprl || (modif === 'AJO' && !r.certifPSI)) {
      await this.audit.log({ operatorId, eventType: AuditEventType.MEV_ERROR, severity: LogSeverity.ERROR, deviceId, description: `CRT ${modif} refused`, metadata: { errors: r.listErr ?? [] } });
      throw new UnprocessableEntityException({ status: 'rejected', errors: r.listErr ?? [{ id: 'CRT', mess: 'no certificate in the answer', codRetour: '99' }] });
    }

    const sevPem = this.toPem(r.certif);
    const x = new crypto.X509Certificate(sevPem);
    const pubFromCert = x.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const pubFromKey = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');
    if (pubFromCert !== pubFromKey) throw new UnprocessableEntityException('The certificate returned does not match our key');

    await this.prisma.$transaction(async (tx) => {
      // A REM answer without a new MEV-WEB certificate keeps the current one (it encrypts the QR codes).
      await tx.certificate.updateMany({ where: { deviceId, isActive: true, ...(r.certifPSI ? {} : { type: CertificateType.SEV }) }, data: { isActive: false } });
      await tx.certificate.create({
        data: {
          operatorId,
          deviceId,
          type: CertificateType.SEV,
          serialNumber: x.serialNumber,
          subject: 'SEV device certificate',
          issuer: x.issuer.split('\n').find((l) => l.startsWith('CN=')) ?? null,
          thumbprint: certThumbprint(sevPem),
          validFrom: new Date(x.validFrom),
          validUntil: new Date(x.validTo),
          pemCertificate: sevPem,
          encryptedPrivateKey: this.vault.encrypt(privateKeyPem, `key:${deviceId}`),
          csrPem: this.vault.encrypt(csrPem, `csr:${deviceId}`),
          isActive: true,
        },
      });
      if (r.certifPSI) {
        const mevPem = this.toPem(r.certifPSI);
        const mx = new crypto.X509Certificate(mevPem);
        await tx.certificate.create({
          data: {
            operatorId,
            deviceId,
            type: CertificateType.MEV_WEB,
            serialNumber: mx.serialNumber,
            subject: mx.subject.split('\n').find((l) => l.startsWith('CN=')) ?? null,
            thumbprint: certThumbprint(mevPem),
            validFrom: new Date(mx.validFrom),
            validUntil: new Date(mx.validTo),
            pemCertificate: mevPem,
            isActive: true,
          },
        });
      }
      await tx.device.update({ where: { id: deviceId }, data: { mevDeviceId: idApprl } });
    });
    await this.audit.log({
      operatorId,
      eventType: AuditEventType.CERTIFICATE_RECEIVED,
      deviceId,
      description: `SEV certificate stored after CRT ${modif} (valid until ${x.validTo})`,
      metadata: { modif, validUntil: new Date(x.validTo).toISOString() },
    });
    this.logger.log(`certificate stored for device ${device.serialNumber} (CRT ${modif})`);
    return { status: modif === 'AJO' ? 'issued' : 'renewed', modif, deviceId, mevDeviceId: idApprl, serialNumber: x.serialNumber, validFrom: new Date(x.validFrom), validUntil: new Date(x.validTo) };
  }

  /** Decrypts the device key for one use. Throws when the device has no usable certificate. */
  async signingMaterial(deviceId: string): Promise<SigningMaterial & { validUntil: Date | null; expired: boolean }> {
    const [device, cert] = await Promise.all([
      this.prisma.device.findUnique({ where: { id: deviceId } }),
      this.prisma.certificate.findFirst({ where: { deviceId, type: CertificateType.SEV, isActive: true }, orderBy: { createdAt: 'desc' } }),
    ]);
    if (!device?.mevDeviceId || !cert?.pemCertificate || !cert.encryptedPrivateKey || !cert.thumbprint) {
      throw new DeviceNotReadyError('certReady', 'the device has no active SEV certificate (run CRT first)');
    }
    const privateKey = crypto.createPrivateKey(this.vault.decrypt(cert.encryptedPrivateKey, `key:${deviceId}`));
    const expired = !!cert.validUntil && cert.validUntil.getTime() < Date.now();
    return { privateKey, certPem: cert.pemCertificate, thumbprint: cert.thumbprint, mevDeviceId: device.mevDeviceId, validUntil: cert.validUntil, expired };
  }

  /** MEV-WEB's certificate (certifPSI) of the device: it encrypts the QR link data (SW-76 §4.2.1). */
  async mevWebCertificate(deviceId: string): Promise<string | null> {
    const cert = await this.prisma.certificate.findFirst({ where: { deviceId, type: CertificateType.MEV_WEB, isActive: true }, orderBy: { createdAt: 'desc' } });
    return cert?.pemCertificate ?? null;
  }

  async readiness(deviceId: string): Promise<DeviceReadiness> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    const cert = await this.prisma.certificate.findFirst({ where: { deviceId, type: CertificateType.SEV, isActive: true }, orderBy: { createdAt: 'desc' } });
    const certReady = !!cert && !!device?.mevDeviceId && (!cert.validUntil || cert.validUntil.getTime() > Date.now()) && !!(await this.mevWebCertificate(deviceId));
    return { deviceReady: !!device?.isActive && !!device.fileNumber, certReady, certificateValidUntil: cert?.validUntil ?? null };
  }

  async listForOperator(operatorId: string) {
    return this.prisma.certificate.findMany({
      where: { operatorId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, deviceId: true, type: true, serialNumber: true, issuer: true, thumbprint: true, validFrom: true, validUntil: true, isActive: true, revokedAt: true, createdAt: true },
    });
  }

  /** Active SEV certificates expiring within `days`; one operator (tenant-scoped API) or every operator (nightly job). */
  async expiring(operatorId: string | null, days = 30) {
    const limit = new Date(Date.now() + days * 86400_000);
    return this.prisma.certificate.findMany({
      where: { ...(operatorId ? { operatorId } : {}), isActive: true, type: CertificateType.SEV, validUntil: { lte: limit }, deviceId: { not: null } },
      select: { id: true, operatorId: true, deviceId: true, validUntil: true },
      orderBy: { validUntil: 'asc' },
    });
  }

  /** The operator's active SEV certificates (one per certified device). */
  async activeForOperator(operatorId: string) {
    return this.prisma.certificate.findMany({
      where: { operatorId, isActive: true, type: CertificateType.SEV },
      orderBy: { createdAt: 'desc' },
      select: { id: true, deviceId: true, serialNumber: true, issuer: true, thumbprint: true, validFrom: true, validUntil: true, createdAt: true },
    });
  }

  /** Local deactivation. SPEC: the CRT "SUP" call with noSerie (40 characters) waits for SW-73. */
  async revoke(operatorId: string, certId: string) {
    const cert = await this.prisma.certificate.findFirst({ where: { id: certId, operatorId } });
    if (!cert) throw new NotFoundException('Certificate not found');
    await this.prisma.certificate.update({ where: { id: certId }, data: { isActive: false, revokedAt: new Date() } });
    await this.audit.log({ operatorId, eventType: AuditEventType.CERTIFICATE_REVOKED, severity: LogSeverity.WARNING, entityId: certId, entityType: 'Certificate', description: 'certificate deactivated locally' });
    return { status: 'revoked', id: certId };
  }

  private toPem(b64OrPem: string): string {
    if (b64OrPem.includes('BEGIN CERTIFICATE')) return b64OrPem;
    const body = b64OrPem.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? '';
    return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
  }
}

export class DeviceNotReadyError extends Error {
  constructor(public readonly field: 'deviceReady' | 'certReady' | 'usersReady', message: string) {
    super(message);
    this.name = 'DeviceNotReadyError';
  }
}
