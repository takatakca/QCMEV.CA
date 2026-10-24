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

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger('Certificates');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mevWeb: MevWebService,
    private readonly audit: AuditLogService,
    @Inject(KEY_VAULT) private readonly vault: KeyVault,
  ) {}

  /** CRT AJO: generate a key pair and CSR, send it, store both certificates and the IDAPPRL. */
  async requestCertificate(operatorId: string, deviceId: string, nickname?: string) {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, operatorId }, include: { operator: true } });
    if (!device) throw new NotFoundException('Device not found');
    if (!device.fileNumber || !device.authorizationCodeEnc) {
      throw new BadRequestException('The device needs its file number and authorization code first (seed:operator)');
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

    await this.audit.log({ operatorId, eventType: AuditEventType.CERTIFICATE_REQUESTED, deviceId, description: `CRT AJO for device ${device.serialNumber}` });
    const res = await this.mevWeb.certificateRequest({ id: op.id, noTPS: op.noTPS, noTVQ: op.noTVQ }, authorizationCode, 'AJO', csrBody(csrPem));
    const r = res?.retourCertif ?? {};
    // SW-76 §4.2.1: the answer carries two certificates (ours, and MEV-WEB's for the QR code); both are required.
    if (classifyErrors(r.listErr) !== 'accepted' || !r.certif || !r.certifPSI || !r.idApprl) {
      await this.audit.log({ operatorId, eventType: AuditEventType.MEV_ERROR, severity: LogSeverity.ERROR, deviceId, description: 'CRT refused', metadata: { errors: r.listErr ?? [] } });
      throw new UnprocessableEntityException({ status: 'rejected', errors: r.listErr ?? [{ id: 'CRT', mess: 'no certificate in the answer', codRetour: '99' }] });
    }

    const sevPem = this.toPem(r.certif);
    const x = new crypto.X509Certificate(sevPem);
    const pubFromCert = x.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const pubFromKey = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');
    if (pubFromCert !== pubFromKey) throw new UnprocessableEntityException('The certificate returned does not match our key');

    await this.prisma.$transaction(async (tx) => {
      await tx.certificate.updateMany({ where: { deviceId, isActive: true }, data: { isActive: false } });
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
      {
        const mevPem = this.toPem(r.certifPSI as string);
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
      await tx.device.update({ where: { id: deviceId }, data: { mevDeviceId: r.idApprl } });
    });
    await this.audit.log({ operatorId, eventType: AuditEventType.CERTIFICATE_RECEIVED, deviceId, description: `SEV certificate stored (valid until ${x.validTo})` });
    this.logger.log(`certificate stored for device ${device.serialNumber}`);
    return { status: 'issued', deviceId, mevDeviceId: r.idApprl, serialNumber: x.serialNumber, validFrom: new Date(x.validFrom), validUntil: new Date(x.validTo) };
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

  async expiring(operatorId: string, days = 30) {
    const limit = new Date(Date.now() + days * 86400_000);
    return this.prisma.certificate.findMany({
      where: { operatorId, isActive: true, type: CertificateType.SEV, validUntil: { lte: limit } },
      select: { id: true, deviceId: true, validUntil: true },
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
