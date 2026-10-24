/**
 * Certificates Controller
 *
 * Manages MEV-WEB digital certificates (SW-76 §3).
 * CRT requests, CSR generation, certificate storage.
 */

import { Controller, Get, Post, Body, UseGuards, Request, HttpCode, HttpStatus } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CertificatesService } from './certificates.service';
import { MevWebService } from '../mev-web/mev-web.service';

@Controller('certificates')
@UseGuards(JwtAuthGuard)
export class CertificatesController {
  constructor(
    private readonly certificatesService: CertificatesService,
    private readonly mevWebService: MevWebService,
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

  /** List expiring certificates (within 30 days) */
  @Get('expiring')
  async getExpiring(@Request() req: any) {
    return this.certificatesService.getExpiringCertificates(30);
  }

  /** Generate a new key pair + CSR, then submit CRT request to MEV-WEB */
  @Post('request')
  @HttpCode(HttpStatus.CREATED)
  async requestCertificate(@Request() req: any, @Body() body: any) {
    const { csrPem, encryptedPrivateKey } = await this.certificatesService.generateKeyPairAndCSR(
      req.user.operatorId,
      body.deviceId,
    );

    const response = await this.mevWebService.submitCertificateRequest(req.user.operatorId, {
      entete: {} as any,
      corps: {
        neq:              body.neq ?? '',
        codeAutorisation: body.codeAutorisation ?? '',
        secteur:          body.secteur ?? 'R',
        csrPem,
      },
    });

    await this.certificatesService.storeMevWebCertificate(
      req.user.operatorId,
      response.certificatPem,
      encryptedPrivateKey,
      response.identifiantCle,
    );

    return { message: 'Certificate issued successfully', identifiantCle: response.identifiantCle };
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
