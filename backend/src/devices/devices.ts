/**
 * Devices (one SEV device per establishment, mode SEV) and their certificates.
 * Every route checks that the device belongs to the caller's operator (another operator's device answers 404).
 * Identity values (file number, authorization code) are write-only: never returned, never logged.
 */
import { Body, ConflictException, Controller, Get, HttpCode, Inject, Injectable, NotFoundException, Param, Post, Put, UseGuards } from '@nestjs/common';
import { AuditEventType, CertificateType, DeviceType, Prisma } from '@prisma/client';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { AuthUser, CurrentUser, JwtAuthGuard, MANAGERS, Roles, RolesGuard } from '../auth/auth';
import { CertificateLifecycleService } from '../certificates/certificate-lifecycle.service';
import { CertificatesService } from '../certificates/certificates.service';
import { KEY_VAULT, KeyVault } from '../crypto/key-vault';
import { AuditLogService } from '../logging/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';
import { RegisterDeviceDto, UpdateDeviceDto } from './dto/device.dto';

const PUBLIC_DEVICE = {
  id: true, serialNumber: true, name: true, model: true, firmwareVersion: true, deviceType: true, description: true, mevDeviceId: true,
  offlineMode: true, offlineSince: true, lastSyncAt: true, isActive: true, createdAt: true,
} as const;

/** POST /api/certificates/request and /api/devices/:id/certificate. */
export class CertificateRequestDto {
  @IsOptional() @IsUUID('4') deviceId?: string;
  /** SN of the CSR subject, 8–32 characters (S1). */
  @IsOptional() @IsString() @MaxLength(32) nickname?: string;
}

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    @Inject(KEY_VAULT) private readonly vault: KeyVault,
  ) {}

  list(operatorId: string) {
    return this.prisma.device.findMany({ where: { operatorId }, select: { ...PUBLIC_DEVICE, _count: { select: { transactions: true } } }, orderBy: { createdAt: 'asc' } });
  }

  async get(operatorId: string, id: string) {
    const d = await this.prisma.device.findFirst({ where: { id, operatorId }, select: PUBLIC_DEVICE });
    if (!d) throw new NotFoundException('Device not found');
    return d;
  }

  /** What the device still needs before it can sign (without revealing the values). */
  async setup(operatorId: string, id: string) {
    const d = await this.prisma.device.findFirst({ where: { id, operatorId }, select: { fileNumber: true, authorizationCodeEnc: true, mevDeviceId: true } });
    if (!d) throw new NotFoundException('Device not found');
    return { hasFileNumber: !!d.fileNumber, hasAuthorizationCode: !!d.authorizationCodeEnc, certified: !!d.mevDeviceId };
  }

  async register(operatorId: string, dto: RegisterDeviceDto) {
    try {
      const created = await this.prisma.device.create({
        data: {
          operatorId,
          serialNumber: dto.serialNumber.trim(),
          deviceType: dto.deviceType ?? DeviceType.SERVER,
          name: dto.name,
          model: dto.model,
          firmwareVersion: dto.firmwareVersion,
          description: dto.description,
          fileNumber: dto.fileNumber,
        },
        select: { id: true },
      });
      if (dto.authorizationCode) {
        await this.prisma.device.update({ where: { id: created.id }, data: { authorizationCodeEnc: this.vault.encrypt(dto.authorizationCode, `auth:${created.id}`) } });
      }
      await this.audit.log({ operatorId, eventType: AuditEventType.SETTINGS_CHANGED, deviceId: created.id, entityId: created.id, entityType: 'Device', description: `device ${dto.serialNumber.trim()} registered` });
      return { ...(await this.get(operatorId, created.id)), ...(await this.setup(operatorId, created.id)) };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('A device with this serial number already exists');
      throw e;
    }
  }

  /** Explicit whitelist. The file number and authorization code are frozen once the device holds a certificate. */
  async update(operatorId: string, id: string, body: UpdateDeviceDto) {
    await this.get(operatorId, id);
    const data: Prisma.DeviceUpdateInput = {};
    for (const k of ['name', 'model', 'firmwareVersion', 'description'] as const) if (typeof body[k] === 'string') data[k] = body[k];
    if (typeof body.isActive === 'boolean') data.isActive = body.isActive;
    if (body.deviceType !== undefined) data.deviceType = body.deviceType;
    if (body.fileNumber !== undefined || body.authorizationCode !== undefined) {
      const certified = await this.prisma.certificate.count({ where: { deviceId: id, type: CertificateType.SEV, isActive: true } });
      if (certified) throw new ConflictException('The file number and authorization code are inside the device certificate: they cannot change once it is certified');
      if (body.fileNumber !== undefined) data.fileNumber = body.fileNumber;
      if (body.authorizationCode !== undefined) data.authorizationCodeEnc = this.vault.encrypt(body.authorizationCode, `auth:${id}`);
    }
    await this.prisma.device.update({ where: { id }, data });
    await this.audit.log({ operatorId, eventType: AuditEventType.SETTINGS_CHANGED, deviceId: id, entityId: id, entityType: 'Device', description: `device settings changed: ${Object.keys(data).map((k) => (k === 'authorizationCodeEnc' ? 'authorizationCode' : k)).join(', ') || 'none'}` });
    return { ...(await this.get(operatorId, id)), ...(await this.setup(operatorId, id)) };
  }

  async offlineStatus(operatorId: string, id: string) {
    const d = await this.get(operatorId, id);
    const [pendingCount, oldest] = await Promise.all([
      this.prisma.offlineQueue.count({ where: { deviceId: id, status: 'PENDING' } }),
      this.prisma.offlineQueue.findFirst({ where: { deviceId: id, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    return { offlineMode: d.offlineMode, offlineSince: d.offlineSince, lastSyncAt: d.lastSyncAt, pendingCount, oldestQueuedAt: oldest?.createdAt ?? null };
  }
}

@Controller('devices')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DevicesController {
  constructor(
    private readonly devices: DevicesService,
    private readonly transactions: TransactionsService,
    private readonly lifecycle: CertificateLifecycleService,
  ) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.devices.list(u.operatorId);
  }

  /** New establishment device (file number and authorization code may be given now or later with PUT). */
  @Post()
  @HttpCode(201)
  @Roles(...MANAGERS)
  register(@CurrentUser() u: AuthUser, @Body() dto: RegisterDeviceDto) {
    return this.devices.register(u.operatorId, dto);
  }

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return { ...(await this.devices.get(u.operatorId, id)), ...(await this.devices.setup(u.operatorId, id)) };
  }

  @Put(':id')
  @Roles(...MANAGERS)
  update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: UpdateDeviceDto) {
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

  /** CRT (AJO the first time, REM to replace the current certificate), then every SEV user is registered (UTL). */
  @Post(':id/certificate')
  @HttpCode(201)
  @Roles(...MANAGERS)
  async certificate(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: CertificateRequestDto) {
    await this.devices.get(u.operatorId, id);
    return this.lifecycle.requestCertificate(u.operatorId, id, 'MANUAL', body?.nickname);
  }
}

@Controller('certificates')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(...MANAGERS)
export class CertificatesController {
  constructor(
    private readonly certificates: CertificatesService,
    private readonly lifecycle: CertificateLifecycleService,
    private readonly devices: DevicesService,
  ) {}

  @Get()
  list(@CurrentUser() u: AuthUser) {
    return this.certificates.listForOperator(u.operatorId);
  }

  /** The operator's active SEV certificates (one per certified device). */
  @Get('active')
  active(@CurrentUser() u: AuthUser) {
    return this.certificates.activeForOperator(u.operatorId);
  }

  /** This operator's certificates expiring within the renewal window (CERT_RENEWAL_DAYS). */
  @Get('expiring')
  expiring(@CurrentUser() u: AuthUser) {
    return this.certificates.expiring(u.operatorId, this.lifecycle.renewalWindowDays);
  }

  /** CRT for a device: body { deviceId } (default: the operator's first active device). */
  @Post('request')
  @HttpCode(201)
  async request(@CurrentUser() u: AuthUser, @Body() body: CertificateRequestDto) {
    const deviceId = body?.deviceId ?? (await this.devices.list(u.operatorId)).find((d) => d.isActive)?.id;
    if (!deviceId) throw new NotFoundException('No active device: register one first (POST /api/devices)');
    await this.devices.get(u.operatorId, deviceId);
    return this.lifecycle.requestCertificate(u.operatorId, deviceId, 'MANUAL', body?.nickname);
  }

  /** Renew now (CRT REM), like the nightly job: body { deviceId } or every certified device of the operator. */
  @Post('renew')
  @HttpCode(201)
  renew(@CurrentUser() u: AuthUser, @Body() body: CertificateRequestDto) {
    return this.lifecycle.renewForOperator(u.operatorId, body?.deviceId);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.certificates.revoke(u.operatorId, id);
  }
}
