/**
 * /api/v1/integrations/foodhub — mounted only when QCMEV_FOODHUB_ENABLED=true.
 * Meant for the Coolify internal network only (no public port). HMAC-signed, no staff JWT.
 */
import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { FOODHUB_THROTTLE } from '../../common/throttle';
import type { Request, Response } from 'express';
import { FoodHubSignatureGuard, SignedRequestInfo } from './foodhub.guard';
import { ApiAnswer, FoodHubService } from './foodhub.service';
import type { FoodHubCreditV1, FoodHubPrintV1, FoodHubSaleV1 } from './foodhub.contract';

type SignedReq = Request & { foodhub: SignedRequestInfo };

function send(res: Response, a: ApiAnswer): void {
  res.status(a.httpStatus).json(a.body);
}

@Controller('v1/integrations/foodhub')
@UseGuards(FoodHubSignatureGuard)
@Throttle(FOODHUB_THROTTLE)
export class FoodHubController {
  constructor(private readonly svc: FoodHubService) {}

  @Get('health')
  health(@Req() req: SignedReq) {
    return this.svc.health(req.foodhub);
  }

  @Post('sales')
  async sale(@Req() req: SignedReq, @Body() body: FoodHubSaleV1, @Res() res: Response) {
    send(res, await this.svc.sale(req.foodhub, body));
  }

  @Get('sales/:saleKey')
  async getSale(@Req() req: SignedReq, @Param('saleKey') saleKey: string, @Res() res: Response) {
    send(res, await this.svc.getSale(req.foodhub, saleKey));
  }

  @Post('sales/:saleKey/credit-notes')
  async credit(@Req() req: SignedReq, @Param('saleKey') saleKey: string, @Body() body: FoodHubCreditV1, @Res() res: Response) {
    send(res, await this.svc.credit(req.foodhub, saleKey, body));
  }

  @Post('sales/:saleKey/prints')
  async print(@Req() req: SignedReq, @Param('saleKey') saleKey: string, @Body() body: FoodHubPrintV1, @Res() res: Response) {
    send(res, await this.svc.print(req.foodhub, saleKey, body));
  }
}
