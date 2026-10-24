/**
 * Certificates Controller
 *
 * Manages MEV-WEB digital certificates (SW-76 §3).
 * CRT requests, CSR generation, certificate storage.
 */

import { Controller, Get, Post, Body, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CertificatesService } from './certificates.service';
import { CertificateLifecycleService } from './certificate-lifecycle.service';

@Controller('certificates')
@UseGuards(JwtAuthGuard)
export class CertificatesController {
  constructor(
    private readonly certificatesService: CertificatesService,
    private readonly lifecycle: CertificateLifecycleService,
  ) {}

  /** Get active certificate for the operator */
  @Get('active')
  async getActive(@Request() req: any) {
    const record = await this.certificatesService.getActiveCertRecord(req.user.operatorId);
    if (!record) return { status: 'none', message: 'No active certificate found' };
    return {
      id:           record.id,
      serialNumber: record.serialNumber,
      subject:      record.subject,
      validFrom:    record.validFrom,
      validTo:      record.validTo,
      type:         record.type,
    };
  }

  /** This operator's certificates expiring within the renewal window (was: every operator's — tenant leak) */
  @Get('expiring')
  async getExpiring(@Request() req: any) {
    return this.certificatesService.getExpiringCertificates(
      this.lifecycle.renewalWindowDays,
      req.user.operatorId,
    );
  }

  /**
   * Generate a new key pair + CSR for a device, submit the CRT request to
   * MEV-WEB, store the certificate, then (re)send UTL for pending users.
   * Body: { deviceId }. NEQ / authorization code / sector come from the operator record.
   */
  @Post('request')
  @HttpCode(HttpStatus.CREATED)
  async requestCertificate(@Request() req: any, @Body() body: { deviceId: string }) {
    const result = await this.lifecycle.requestCertificate(req.user.operatorId, body?.deviceId, 'MANUAL');
    return { message: 'Certificate issued successfully', ...result };
  }

  /** Renew this operator's certificate now (same as the nightly job, for one operator) */
  @Post('renew')
  @HttpCode(HttpStatus.CREATED)
  async renew(@Request() req: any) {
    const result = await this.lifecycle.renewForOperator(req.user.operatorId);
    return { message: 'Certificate renewed', ...result };
  }

  /** Revoke the active certificate */
  @Post('revoke')
  @HttpCode(HttpStatus.OK)
  async revoke(@Request() req: any, @Body() body: any) {
    const record = await this.certificatesService.getActiveCertRecord(req.user.operatorId);
    if (!record) return { message: 'No active certificate to revoke' };
    await this.certificatesService.revokeCertificate(record.id);
    return { message: 'Certificate revoked' };
  }
}
