/**
 * Partner API authentication: `Authorization: Bearer tkp_…` (or `X-Api-Key: tkp_…`).
 * Only the SHA-256 of a key is stored; a revoked key is refused. Sets req.partner.
 */

import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hashApiKey } from './api-key.util';

export interface PartnerContext {
  keyId:      string;
  operatorId: string;
  userId:     string;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const auth = String(req.headers['authorization'] ?? '');
    const key = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : String(req.headers['x-api-key'] ?? '').trim();
    if (!key.startsWith('tkp_')) throw new UnauthorizedException('Partner API key required (Authorization: Bearer tkp_…)');

    const apiKey = await this.prisma.apiKey.findUnique({ where: { keyHash: hashApiKey(key) } });
    if (!apiKey || apiKey.revokedAt) throw new UnauthorizedException('Invalid or revoked API key');

    // Last use is informative only: never block a sale on this write
    this.prisma.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

    req.partner = { keyId: apiKey.id, operatorId: apiKey.operatorId, userId: apiKey.userId } satisfies PartnerContext;
    return true;
  }
}
