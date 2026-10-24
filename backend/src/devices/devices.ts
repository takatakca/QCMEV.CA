/**
 * Devices (one per establishment in remote-server mode) and their certificates.
 * Every route checks that the device belongs to the caller's operator. Identity values are never returned.
 */
import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { DeviceType } from '@prisma/client';
import { AuthUser, CurrentUser, JwtAuthGuard, MANAGERS, Roles, RolesGuard } from '../auth/auth';
import { CertificatesService } from '../certificates/certificates.service';
import { OperatorsService } from '../operators/operators';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';

const PUBLIC_DEVICE = {
  id: true, serialNumber: true, deviceType: true, description: true, mevDeviceId: true, offlineMode: true, offlineSince: true,
  lastSyncAt: true, isActive: true, createdAt: true,
} as const;

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  list(operatorId: string) {
    return this.prisma.device.findMany({ where: { operatorId }, select: { ...PUBLIC_DEVICE, _count: { select: { transactions: true } } }, orderBy: { createdAt: 'asc' } });
  }

  async get(operatorId: string, id: string) {
    const d = await this.prisma.device.findFirst({ where: { id, operatorId }, select: PUBLIC_DEVICE });
    if (!d) throw new NotFoundException('Device not found');
    return d;
  }

  async update(operatorId: string, id: string, body: { description?: string; isActive?: boolean; deviceType?: string }) {
    await this.get(operatorId, id);
    const data: { description?: string; isActive?: boolean; deviceType?: DeviceType } = {};
    if (typeof body.description === 'string') data.description = body.description.slice(0, 200);
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    if (body.deviceType !== undefined) {
      if (!Object.values(DeviceType).includes(body.deviceType as DeviceType)) throw new BadRequestException('invalid deviceType');
      data.deviceType = body.deviceType as DeviceType;
    }
    return this.prisma.device.update({ where: { id }, data, select: PUBLIC_DEVICE });
  }

  async offlineStatus(operatorId: string, id: string) {
    const d = await this.get(operatorId, id);
    const [pendingCount, oldest] = await Promise.all([
      this.prisma.offlineQueue.count({ where: { deviceId: id, status: 'PENDING' } }),
      this.prisma.offlineQueue.findFirst({ where: { deviceId: id, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    return { offlineMode: d.offlineMode, offlineSince: d.offlineSince, pendingCount, oldestQueuedAt: oldest?.createdAt ?? null };
  }
}

@Controller('devices')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly transactions: TransactionsService,
    private readonly certificates: CertificatesService,
    private readonly operators: OperatorsService,
  ) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.devices.list(u.operatorId);
  }

  @Get(':id')
  get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.devices.get(u.operatorId, id);
  }

  @Put(':id')
  @Roles(...MANAGERS)
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    return this.devices.update(u.operatorId, id, body ?? {});
  }

  @Get(':id/offline-status')
  offline(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.devices.offlineStatus(u.operatorId, id);
  }

  /** Sends the device's waiting transactions now (also done automatically every MEV_OFFLINE_FLUSH_SECONDS). */
  @Post(':id/flush-queue')
  @HttpCode(200)
  async flush(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.devices.get(u.operatorId, id);
    const result = await this.transactions.submitDevice(id);
    return { ...result, ...(await this.devices.offlineStatus(u.operatorId, id)) };
  }

  /** CRT: new key pair + CSR, certificate from MEV-WEB, then every SEV user is registered on the device (UTL). */
  @Post(':id/certificate')
  @HttpCode(201)
  @Roles(...MANAGERS)
  async certificate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: { nickname?: string }) {
    await this.devices.get(u.operatorId, id);
    const issued = await this.certificates.requestCertificate(u.operatorId, id, body?.nickname);
    const users = await this.operators.syncUsersToDevice(u.operatorId, id);
    return { ...issued, usersRegistered: users.filter((x) => x.ok).length, usersFailed: users.filter((x) => !x.ok).length };
  }
}

@Controller('certificates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MANAGERS)
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.certificates.listForOperator(u.operatorId);
  }

  @Get('expiring')
  expiring(@CurrentUser() u: AuthUser) {
    return this.certificates.expiring(u.operatorId, 30);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.certificates.revoke(u.operatorId, id);
  }
}
