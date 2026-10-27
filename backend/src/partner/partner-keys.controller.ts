/**
 * Partner API keys — operator admins only (JWT).
 *   POST   /api/partner/keys        { label, userId? } → the key, shown ONCE
 *   GET    /api/partner/keys        list (prefix only)
 *   DELETE /api/partner/keys/:id    revoke
 */

import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, Request, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PartnerService } from './partner.service';
import { CreateApiKeyDto } from './dto/partner.dto';

@Controller('partner/keys')
@UseGuards(JwtAuthGuard)
export class PartnerKeysController {
  constructor(private readonly partner: PartnerService) {}

  private assertAdmin(req: any) {
    if (req.user.role !== UserRole.ADMIN) throw new ForbiddenException('Only an operator admin can manage API keys');
  }

  @Post()
  create(@Request() req: any, @Body() dto: CreateApiKeyDto) {
    this.assertAdmin(req);
    return this.partner.createKey(req.user.operatorId, req.user.sub, dto.label, dto.userId);
  }

  @Get()
  list(@Request() req: any) {
    this.assertAdmin(req);
    return this.partner.listKeys(req.user.operatorId);
  }

  @Delete(':id')
  revoke(@Request() req: any, @Param('id') id: string) {
    this.assertAdmin(req);
    return this.partner.revokeKey(req.user.operatorId, req.user.sub, id);
  }
}
