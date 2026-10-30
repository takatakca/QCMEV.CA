/**
 * Food Hub locations (kitchens) → SEV device, set up by the operator's staff (JWT, ADMIN / MANAGER), without the seed CLI:
 *   GET    /api/operators/foodhub-locations        the operator's links, each with its readiness (as /health shows it)
 *   PUT    /api/operators/foodhub-locations        { tenantId, locationId, deviceId }: link (or move) a location
 *   DELETE /api/operators/foodhub-locations/:id    unlink (the row is kept, inactive, for the audit trail)
 * Linking also creates the operator's FOODHUB-AUTO system user (no password, cannot log in) when it is missing, and
 * registers it with MEV-WEB (UTL AJO) as soon as the operator has a certified device, so the location becomes ready.
 * Mounted even when QCMEV_FOODHUB_ENABLED=false: the setup can be done before the integration is turned on.
 * A (tenantId, locationId) pair belongs to one operator only: another operator's location answers 409.
 */
import { Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Put, UseGuards } from '@nestjs/common';
import { AuditEventType, UserRole } from '@prisma/client';
import { IsString, IsUUID, Matches } from 'class-validator';
import { AuthUser, CurrentUser, JwtAuthGuard, MANAGERS, Roles, RolesGuard } from '../../auth/auth';
import { CertificatesService } from '../../certificates/certificates.service';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { AuditLogService } from '../../logging/audit-log.service';
import { OperatorsService } from '../../operators/operators';
import { PrismaService } from '../../prisma/prisma.service';
import { FOODHUB_AUTO, FOODHUB_AUTO_EXTERNAL_ID } from './foodhub.service';

/** Same rules as the signed calls: X-Tenant-Id (foodhub.guard.ts) and the body's locationId (foodhub.contract.ts). */
export const TENANT_ID = /^[a-z0-9][a-z0-9-]{1,39}$/;
export const LOCATION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** PUT /api/operators/foodhub-locations */
export class LinkFoodHubLocationDto {
  @IsString() @Matches(TENANT_ID, { message: 'tenantId: the Food Hub tenant slug (lower-case letters, digits and -)' })
  tenantId!: string;

  @IsString() @Matches(LOCATION_ID, { message: 'locationId: 1–64 letters, digits, _ or - (the Food Hub kitchen id)' })
  locationId!: string;

  @IsUUID('4')
  deviceId!: string;
}

export interface FoodHubLocationView {
  id: string;
  tenantId: string;
  locationId: string;
  isActive: boolean;
  device: { id: string; name: string | null; serialNumber: string; mevDeviceId: string | null };
  /** The same three flags GET /api/v1/integrations/foodhub/health gives Food Hub for this location. */
  deviceReady: boolean;
  certReady: boolean;
  usersReady: boolean;
  certificateValidUntil: Date | null;
}

@Injectable()
export class FoodHubLocationsService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly certificates: CertificatesService,
    private readonly operators: OperatorsService,
    private readonly audit: AuditLogService,
  ) {}

  private async view(m: { id: string; tenantId: string; locationId: string; isActive: boolean; operatorId: string; deviceId: string }): Promise<FoodHubLocationView> {
    const device = await this.prisma.device.findUniqueOrThrow({ where: { id: m.deviceId }, select: { id: true, name: true, serialNumber: true, mevDeviceId: true } });
    const r = await this.certificates.readiness(m.deviceId);
    const auto = await this.prisma.sEVUser.findUnique({ where: { operatorId_externalId: { operatorId: m.operatorId, externalId: FOODHUB_AUTO_EXTERNAL_ID } } });
    return {
      id: m.id,
      tenantId: m.tenantId,
      locationId: m.locationId,
      isActive: m.isActive,
      device,
      deviceReady: r.deviceReady,
      certReady: r.certReady,
      usersReady: !!auto?.isActive && !!auto.mevRegisteredAt,
      certificateValidUntil: r.certificateValidUntil,
    };
  }

  async list(operatorId: string): Promise<{ foodhubEnabled: boolean; locations: FoodHubLocationView[] }> {
    const maps = await this.prisma.locationMapping.findMany({ where: { operatorId }, orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }] });
    const locations: FoodHubLocationView[] = [];
    for (const m of maps) locations.push(await this.view(m));
    return { foodhubEnabled: this.cfg.foodhub.enabled, locations };
  }

  /** The operator's FOODHUB-AUTO user (created if missing, like seed:operator), registered with UTL when possible. */
  private async ensureAutoUser(operatorId: string): Promise<{ created: boolean; registration: string }> {
    let auto = await this.prisma.sEVUser.findUnique({ where: { operatorId_externalId: { operatorId, externalId: FOODHUB_AUTO_EXTERNAL_ID } } });
    const created = !auto;
    if (!auto) {
      auto = await this.prisma.sEVUser.create({
        data: { operatorId, username: `foodhub-auto.${operatorId.slice(0, 8)}`, passwordHash: null, firstName: 'Food Hub', lastName: 'auto', role: UserRole.SYSTEM, mevUserName: FOODHUB_AUTO, externalId: FOODHUB_AUTO_EXTERNAL_ID, isActive: true },
      });
      await this.audit.log({ operatorId, eventType: AuditEventType.USER_REGISTERED, userId: auto.id, entityId: auto.id, entityType: 'SEVUser', description: `system user ${FOODHUB_AUTO} created for the Food Hub integration` });
    } else if (!auto.isActive) {
      return { created, registration: 'inactive' };
    }
    if (auto.mevRegisteredAt) return { created, registration: 'registered' };
    try {
      await this.operators.registerSevUser(operatorId, auto.id, 'AJO');
      return { created, registration: 'registered' };
    } catch (e) {
      // No certified device yet, or MEV-WEB refused / unreachable: the CRT (POST /api/devices/:id/certificate) or
      // POST /api/operators/users/sync-mev registers it later.
      return { created, registration: `not_registered: ${(e as Error).message}` };
    }
  }

  async link(user: AuthUser, dto: LinkFoodHubLocationDto) {
    const operatorId = user.operatorId;
    const device = await this.prisma.device.findFirst({ where: { id: dto.deviceId, operatorId }, select: { id: true, isActive: true, serialNumber: true } });
    if (!device) throw new NotFoundException('Device not found');
    if (!device.isActive) throw new ConflictException('This device is inactive: link the location to an active device');
    const existing = await this.prisma.locationMapping.findUnique({ where: { tenantId_locationId: { tenantId: dto.tenantId, locationId: dto.locationId } } });
    if (existing && existing.operatorId !== operatorId) throw new ConflictException('This Food Hub location is linked to another operator');
    const m = existing
      ? await this.prisma.locationMapping.update({ where: { id: existing.id }, data: { deviceId: device.id, isActive: true } })
      : await this.prisma.locationMapping.create({ data: { tenantId: dto.tenantId, locationId: dto.locationId, operatorId, deviceId: device.id } });
    await this.audit.log({
      operatorId,
      eventType: AuditEventType.SETTINGS_CHANGED,
      userId: user.sub,
      deviceId: device.id,
      entityId: m.id,
      entityType: 'LocationMapping',
      description: `Food Hub location ${dto.tenantId}/${dto.locationId} linked to device ${device.serialNumber}${existing && existing.deviceId !== device.id ? ' (moved)' : ''}`,
    });
    const auto = await this.ensureAutoUser(operatorId);
    return { ...(await this.view(m)), foodhubAuto: auto };
  }

  async unlink(user: AuthUser, id: string) {
    const m = await this.prisma.locationMapping.findFirst({ where: { id, operatorId: user.operatorId } });
    if (!m) throw new NotFoundException('Food Hub location not found');
    const off = await this.prisma.locationMapping.update({ where: { id }, data: { isActive: false } });
    await this.audit.log({ operatorId: user.operatorId, eventType: AuditEventType.SETTINGS_CHANGED, userId: user.sub, deviceId: m.deviceId, entityId: m.id, entityType: 'LocationMapping', description: `Food Hub location ${m.tenantId}/${m.locationId} unlinked: its sales answer 423 location_not_ready` });
    return this.view(off);
  }
}

@Controller('operators/foodhub-locations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MANAGERS)
export class FoodHubLocationsController {
  constructor(private readonly svc: FoodHubLocationsService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.svc.list(u.operatorId);
  }

  @Put()
  link(@CurrentUser() u: AuthUser, @Body() body: LinkFoodHubLocationDto) {
    return this.svc.link(u, body);
  }

  @Delete(':id')
  @HttpCode(200)
  unlink(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.svc.unlink(u, id);
  }
}
