/**
 * Certificates Service
 *
 * Manages the full lifecycle of MEV-WEB digital certificates:
 *  - RSA-2048 keypair generation
 *  - CSR creation with required subject fields
 *  - Certificate storage (encrypted private key)
 *  - RSA-SHA256 signing for MEV-WEB request headers
 *  - mTLS agent creation for HTTPS requests
 *  - QR code data encryption with MEV-WEB's public key
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as forge from 'node-forge';
import * as crypto from 'crypto';
import * as https from 'https';
import { PrismaService } from '../prisma/prisma.service';
import { CertificateType, AuditEventType, LogSeverity } from '@prisma/client';
import { AuditLogService } from '../logging/audit-log.service';

// In-memory cache: operatorId → { cert, privateKey }
const certCache = new Map<string, { cert: string; privateKey: forge.pki.rsa.PrivateKey }>();

@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly auditLogService: AuditLogService,
  ) {
    this.encryptionKey = this.configService.getOrThrow<string>('PRIVATE_KEY_ENCRYPTION_KEY');
  }

  // ─── Key Generation & CSR ─────────────────────────────────────────────────

  /**
   * Generate RSA-2048 keypair and create a CSR for the operator device.
   * Subject fields follow SW-76 §6.1 requirements.
   */
  async generateKeyPairAndCSR(operatorId: string, deviceId: string): Promise<{ csrPem: string; encryptedPrivateKey: string }> {
    this.logger.log(`Generating RSA-2048 keypair for operator ${operatorId}`);

    const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!operator) throw new NotFoundException('Operator not found');

    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new NotFoundException('Device not found');

    return new Promise((resolve, reject) => {
      forge.pki.rsa.generateKeyPair({ bits: 2048, workers: -1 }, (err, keypair) => {
        if (err) return reject(err);

        // Build CSR
        const csr = forge.pki.createCertificationRequest();
        csr.publicKey = keypair.publicKey;

        csr.setSubject([
          { name: 'commonName',         value: `${operator.name} - ${device.serialNumber}` },
          { name: 'organizationName',   value: operator.name },
          { name: 'organizationalUnitName', value: 'Takatak MEV SEV' },
          { name: 'countryName',        value: 'CA' },
          { name: 'stateOrProvinceName', value: 'QC' },
          { name: 'localityName',       value: operator.city ?? 'Québec' },
          { shortName: 'serialNumber',  value: device.id },
        ]);

        // SAN extension with device UUID
        csr.setAttributes([{
          name: 'extensionRequest',
          extensions: [{
            name: 'subjectAltName',
            altNames: [{ type: 2, value: `${device.id}.mev.takatak.ca` }],
          }],
        }]);

        csr.sign(keypair.privateKey, forge.md.sha256.create());
        const csrPem = forge.pki.certificationRequestToPem(csr);
        const encryptedPrivateKey = this.encryptPrivateKey(forge.pki.privateKeyToPem(keypair.privateKey));

        resolve({ csrPem, encryptedPrivateKey });
      });
    });
  }

  // ─── Certificate Storage ──────────────────────────────────────────────────

  async storeMevWebCertificate(
    operatorId: string,
    certPem: string,
    encryptedPrivateKey: string,
    mevKeyId: string,
  ): Promise<void> {
    const cert = forge.pki.certificateFromPem(certPem);

    // Deactivate old certificates
    await this.prisma.certificate.updateMany({
      where: { operatorId, type: CertificateType.OPERATOR, isActive: true },
      data: { isActive: false },
    });

    await this.prisma.certificate.create({
      data: {
        operatorId,
        type: CertificateType.OPERATOR,
        serialNumber: cert.serialNumber,
        subject: cert.subject.getField('CN')?.value ?? '',
        issuer: cert.issuer.getField('CN')?.value ?? '',
        validFrom: cert.validity.notBefore,
        validUntil: cert.validity.notAfter,
        pemCertificate: certPem,
        encryptedPrivateKey,
        mevKeyId,
        isActive: true,
      },
    });

    // Warm the cache
    certCache.delete(operatorId);
    this.logger.log(`Certificate stored for operator ${operatorId} (expires ${cert.validity.notAfter})`);
  }

  async getActiveOperatorCert(operatorId: string): Promise<{ cert: string; privateKey: forge.pki.rsa.PrivateKey } | null> {
    if (certCache.has(operatorId)) return certCache.get(operatorId)!;

    const record = await this.prisma.certificate.findFirst({
      where: { operatorId, type: CertificateType.OPERATOR, isActive: true },
    });
    if (!record?.pemCertificate || !record.encryptedPrivateKey) return null;

    const privateKeyPem = this.decryptPrivateKey(record.encryptedPrivateKey);
    const privateKey = forge.pki.privateKeyFromPem(privateKeyPem) as forge.pki.rsa.PrivateKey;
    const entry = { cert: record.pemCertificate, privateKey };
    certCache.set(operatorId, entry);
    return entry;
  }

  // ─── Signing ─────────────────────────────────────────────────────────────

  /**
   * RSA-SHA256 sign data with the operator's private key.
   * Returns Base64-encoded signature per SW-76 §5.2.
   */
  async signData(operatorId: string, data: string): Promise<string> {
    const certData = await this.getActiveOperatorCert(operatorId);
    if (!certData) {
      this.logger.warn(`No active certificate for ${operatorId} — using unsigned placeholder`);
      return 'UNSIGNED_DEV_PLACEHOLDER';
    }

    const md = forge.md.sha256.create();
    md.update(data, 'utf8');
    const signature = certData.privateKey.sign(md);
    return Buffer.from(signature, 'binary').toString('base64');
  }

  /**
   * Verify an RSA-SHA256 signature against the stored certificate.
   */
  async verifySignature(operatorId: string, data: string, signatureBase64: string): Promise<boolean> {
    try {
      const certData = await this.getActiveOperatorCert(operatorId);
      if (!certData) return false;

      const cert = forge.pki.certificateFromPem(certData.cert);
      const publicKey = cert.publicKey as forge.pki.rsa.PublicKey;
      const md = forge.md.sha256.create();
      md.update(data, 'utf8');
      const signature = Buffer.from(signatureBase64, 'base64').toString('binary');
      return publicKey.verify(md.digest().bytes(), signature);
    } catch {
      return false;
    }
  }

  // ─── mTLS Agent ───────────────────────────────────────────────────────────

  /**
   * Create an HTTPS agent with the operator's certificate for mTLS.
   * Returns a plain agent in simulator/development environments.
   */
  async createHttpsAgent(operatorId: string): Promise<https.Agent | undefined> {
    const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!operator || ['SIMULATOR', 'DEVELOPMENT'].includes(operator.environment)) {
      return undefined; // No mTLS needed for simulator
    }

    const certData = await this.getActiveOperatorCert(operatorId);
    if (!certData) return undefined;

    const record = await this.prisma.certificate.findFirst({
      where: { operatorId, isActive: true },
    });

    return new https.Agent({
      cert: record?.pemCertificate ?? undefined,
      key: certData ? forge.pki.privateKeyToPem(certData.privateKey) : undefined,
      rejectUnauthorized: operator.environment === 'PRODUCTION',
    });
  }

  // ─── QR Code Encryption ───────────────────────────────────────────────────

  /**
   * Encrypt the QR URL with MEV-WEB's public key for display on receipts.
   * The encrypted URL is what gets encoded into the QR code image.
   */
  async encryptQrData(qrUrl: string, mevPublicKeyPem?: string): Promise<string> {
    if (!mevPublicKeyPem) {
      // Return the URL directly for simulator mode
      return qrUrl;
    }
    try {
      const publicKey = crypto.createPublicKey(mevPublicKeyPem);
      const encrypted = crypto.publicEncrypt(
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING },
        Buffer.from(qrUrl),
      );
      return encrypted.toString('base64');
    } catch (err) {
      this.logger.warn('QR encryption failed, using plain URL');
      return qrUrl;
    }
  }

  // ─── Private Key Encryption ───────────────────────────────────────────────

  private encryptPrivateKey(privateKeyPem: string): string {
    const iv = crypto.randomBytes(16);
    const key = Buffer.from(this.encryptionKey.padEnd(32, '0').slice(0, 32));
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(privateKeyPem, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}:${encrypted.toString('base64')}`;
  }

  private decryptPrivateKey(encryptedData: string): string {
    const [ivB64, dataB64] = encryptedData.split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const key = Buffer.from(this.encryptionKey.padEnd(32, '0').slice(0, 32));
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  }

  // ─── Certificate Lifecycle ────────────────────────────────────────────────

  async getExpiringCertificates(daysBeforeExpiry = 30): Promise<Array<{ operatorId: string; validUntil: Date }>> {
    const threshold = new Date();
    threshold.setDate(threshold.getDate() + daysBeforeExpiry);
    return this.prisma.certificate.findMany({
      where: { isActive: true, validUntil: { lte: threshold } },
      select: { operatorId: true, validUntil: true },
    });
  }

  async revokeCertificate(certId: string): Promise<void> {
    await this.prisma.certificate.update({
      where: { id: certId },
      data: { isActive: false, revokedAt: new Date() },
    });
    // Clear cache
    certCache.clear();
  }
}
