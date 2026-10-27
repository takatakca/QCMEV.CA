/**
 * Partner API v1 — for the TAKATAK MEV Clover app, Food Hub and other POS.
 * Auth: `Authorization: Bearer tkp_…` (key created in Settings → API keys, shown once).
 * Every record is addressed by the partner's own id: /sales/:source/:externalRef
 *
 *   POST /api/partner/v1/sales                              record a sale (201; 200 when already recorded)
 *   GET  /api/partner/v1/sales/:source/:ref[?receipt=1]     status, MEV number, receipt link (+ text and QR)
 *   POST /api/partner/v1/sales/:source/:ref/void            cancel the whole sale (ANN)
 *   POST /api/partner/v1/sales/:source/:ref/refund          credit note for some/all lines (NDC)
 *   GET  /api/partner/v1/status                             is this SEV ready (certificate, devices, queue)
 */

import { Body, Controller, Get, Param, Post, Query, Request, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiKeyGuard } from './api-key.guard';
import { PartnerService } from './partner.service';
import { PartnerRefundDto, PartnerSaleDto, PartnerVoidDto } from './dto/partner.dto';

@Controller('partner/v1')
@UseGuards(ApiKeyGuard)
export class PartnerController {
  constructor(private readonly partner: PartnerService) {}

  @Get('status')
  status(@Request() req: any) {
    return this.partner.status(req.partner);
  }

  @Post('sales')
  async create(@Request() req: any, @Body() dto: PartnerSaleDto, @Res({ passthrough: true }) res: Response) {
    const { created, record } = await this.partner.createSale(req.partner, dto);
    res.status(created ? 201 : 200);
    return record;
  }

  @Get('sales/:source/:ref')
  get(@Request() req: any, @Param('source') source: string, @Param('ref') ref: string, @Query('receipt') receipt?: string) {
    return this.partner.getSale(req.partner, source, ref, receipt === '1' || receipt === 'true');
  }

  @Post('sales/:source/:ref/void')
  async void(
    @Request() req: any,
    @Param('source') source: string,
    @Param('ref') ref: string,
    @Body() dto: PartnerVoidDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, record } = await this.partner.voidSale(req.partner, source, ref, dto);
    res.status(created ? 201 : 200);
    return record;
  }

  @Post('sales/:source/:ref/refund')
  async refund(
    @Request() req: any,
    @Param('source') source: string,
    @Param('ref') ref: string,
    @Body() dto: PartnerRefundDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { created, record } = await this.partner.refundSale(req.partner, source, ref, dto);
    res.status(created ? 201 : 200);
    return record;
  }
}
