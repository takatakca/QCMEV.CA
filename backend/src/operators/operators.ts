/**
 * Operator settings and SEV users (UTL).
 *
 * registerSevUser(): UTL request (modif AJO / SUP / VAL) signed by each certified device of the operator;
 * the user's nomUtil is stored once MEV-WEB accepts it on every device. Never returns identity values or
 * authorization codes.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { AuditEventType, CertificateType, LogSeverity, UserRole } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AuthService, AuthUser, CurrentUser, JwtAuthGuard, MANAGERS, Roles, RolesGuard } from '../auth/auth';
import { CertificatesService } from '../certificates/certificates.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MevWebService } from '../mev-web/mev-web.service';
import { classifyErrors, MevError, Modif } from '../mev-web/mev-web.types';
import { PrismaService } from '../prisma/prisma.service';

const NOM_UTIL = /^[A-Za-z0-9À-ÿ .'#_-]{2,50}$/;

@Injectable()
export class OperatorsService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly certificates: CertificatesService,
    private readonly mevWeb: MevWebService,
    private readonly audit: AuditLogService,
  ) {}

  async me(operatorId: string) {
    const op = await this.prisma.operator.findUnique({
      where: { id: operatorId },
      select: { id: true, name: true, sector: true, address: true, city: true, province: true, postalCode: true, environment: true, createdAt: true },
    });
    if (!op) throw new NotFoundException('Operator not found');
    return { ...op, serverEnvironment: this.cfg.mevEnvironment, certified: this.cfg.certified };
  }

  /** Whitelisted fields only. Environment changes: ADMIN only, explicit confirmation, and only to the server's environment. */
  async update(user: AuthUser, body: Record<string, unknown>) {
    const data: Record<string, string> = {};
    for (const k of ['name', 'address', 'city', 'postalCode'] as const) {
      if (typeof body[k] === 'string') data[k] = (body[k] as string).trim().slice(0, 200);
    }
    if (body.environment !== undefined) {
      if (user.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change the environment');
      if (body.environment !== this.cfg.mevEnvironment) throw new BadRequestException(`The server runs ${this.cfg.mevEnvironment}; the operator can only be moved to it`);
      if (body.confirm !== `CONFIRM ${body.environment}`) throw new BadRequestException(`Send confirm: "CONFIRM ${body.environment}"`);
      data.environment = body.environment as string;
    }
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to update');
    await this.prisma.operator.update({ where: { id: user.operatorId }, data });
    await this.audit.log({ operatorId: user.operatorId, eventType: AuditEventType.SETTINGS_CHANGED, severity: data.environment ? LogSeverity.WARNING : LogSeverity.INFO, userId: user.sub, description: `operator settings changed: ${Object.keys(data).join(', ')}` });
    return this.me(user.operatorId);
  }

  async listUsers(operatorId: string) {
    return this.prisma.sEVUser.findMany({
      where: { operatorId },
      select: { id: true, username: true, firstName: true, lastName: true, role: true, mevUserName: true, mevRegisteredAt: true, isActive: true, externalId: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async createUser(operatorId: string, body: { username?: string; password?: string; firstName?: string; lastName?: string; role?: string; mevUserName?: string }) {
    const role = (body.role ?? 'CASHIER') as UserRole;
    if (!['ADMIN', 'MANAGER', 'CASHIER'].includes(role)) throw new BadRequestException('role must be ADMIN, MANAGER or CASHIER');
    if (!body.username || !/^[a-z0-9._@-]{3,60}$/i.test(body.username)) throw new BadRequestException('username: 3–60 letters, digits, . _ @ -');
    let passwordHash: string;
    try {
      passwordHash = await AuthService.hash(String(body.password ?? ''));
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const mevUserName = (body.mevUserName ?? `${body.firstName ?? ''} ${body.lastName ?? ''}`.trim()) || body.username;
    if (!NOM_UTIL.test(mevUserName)) throw new BadRequestException('mevUserName: 2–50 characters');
    const user = await this.prisma.sEVUser.create({
      data: { operatorId, username: body.username, passwordHash, firstName: body.firstName ?? '', lastName: body.lastName ?? '', role, mevUserName },
      select: { id: true, username: true, role: true, mevUserName: true },
    });
    const registration = await this.registerSevUser(operatorId, user.id, 'AJO').catch((e: unknown) => ({ status: 'not_registered', reason: (e as Error).message }));
    return { ...user, registration };
  }

  /** UTL request on every certified device of the operator. */
  async registerSevUser(operatorId: string, userId: string, modif: Modif = 'AJO', onlyDeviceId?: string) {
    const user = await this.prisma.sEVUser.findFirst({ where: { id: userId, operatorId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.mevUserName) throw new BadRequestException('The user has no nomUtil');
    const op = await this.prisma.operator.findUniqueOrThrow({ where: { id: operatorId } });
    const devices = await this.prisma.device.findMany({
      where: { operatorId, isActive: true, mevDeviceId: { not: null }, ...(onlyDeviceId ? { id: onlyDeviceId } : {}), certificates: { some: { type: CertificateType.SEV, isActive: true } } },
    });
    if (!devices.length) throw new UnprocessableEntityException('No certified device yet: run the certificate request (CRT) first');
    const errors: MevError[] = [];
    for (const d of devices) {
      const m = await this.certificates.signingMaterial(d.id);
      const res = await this.mevWeb.userRequest({ id: op.id, noTPS: op.noTPS, noTVQ: op.noTVQ }, m, modif, user.mevUserName);
      const listErr = res?.retourUtil?.listErr ?? [];
      if (classifyErrors(listErr) !== 'accepted') errors.push(...listErr);
    }
    if (errors.length) {
      await this.audit.log({ operatorId, eventType: AuditEventType.MEV_ERROR, severity: LogSeverity.ERROR, userId, description: `UTL ${modif} refused`, metadata: { errors } });
      throw new UnprocessableEntityException({ status: 'rejected', errors });
    }
    const data = modif === 'SUP' ? { mevRegisteredAt: null, isActive: false } : { mevRegisteredAt: new Date(), mevUserId: user.mevUserName };
    if (modif !== 'VAL') await this.prisma.sEVUser.update({ where: { id: userId }, data });
    await this.audit.log({ operatorId, eventType: AuditEventType.USER_REGISTERED, userId, description: `UTL ${modif} for ${user.mevUserName} on ${devices.length} device(s)` });
    return { status: 'registered', modif, nomUtil: user.mevUserName, devices: devices.length };
  }

  /** After a new certificate, every registered user is registered again on that device. */
  async syncUsersToDevice(operatorId: string, deviceId: string) {
    const users = await this.prisma.sEVUser.findMany({ where: { operatorId, isActive: true, mevUserName: { not: null } } });
    const out: Array<{ userId: string; ok: boolean }> = [];
    for (const u of users) {
      try {
        await this.registerSevUser(operatorId, u.id, 'AJO', deviceId);
        out.push({ userId: u.id, ok: true });
      } catch {
        out.push({ userId: u.id, ok: false });
      }
    }
    return out;
  }

  async mevStatus(operatorId: string) {
    const [devices, queue, oldest] = await Promise.all([
      this.prisma.device.findMany({ where: { operatorId }, select: { id: true, serialNumber: true, mevDeviceId: true, offlineMode: true, offlineSince: true, lastSyncAt: true } }),
      this.prisma.offlineQueue.count({ where: { device: { operatorId }, status: 'PENDING' } }),
      this.prisma.offlineQueue.findFirst({ where: { device: { operatorId }, status: 'PENDING' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    const certs = await this.certificates.expiring(operatorId, 3650);
    return {
      environment: this.cfg.mevEnvironment,
      certified: this.cfg.certified,
      hasCertificate: certs.length > 0,
      certificateExpiry: certs.map((c) => c.validUntil).sort()[0] ?? null,
      offlineDeviceCount: devices.filter((d) => d.offlineMode).length,
      pendingQueueSize: queue,
      oldestQueuedAt: oldest?.createdAt ?? null,
      devices,
      ...this.mevWeb.reachability(),
    };
  }
}

@Controller('operators')
@UseGuards(JwtAuthGuard, RolesGuard)
export class OperatorsController {
  constructor(private readonly ops: OperatorsService) {}

  @Get('me')
  me(@CurrentUser() u: AuthUser) {
    return this.ops.me(u.operatorId);
  }

  @Get('mev-status')
  mevStatus(@CurrentUser() u: AuthUser) {
    return this.ops.mevStatus(u.operatorId);
  }

  @Put('me')
  @Roles(...MANAGERS)
  update(@CurrentUser() u: AuthUser, @Body() body: Record<string, unknown>) {
    return this.ops.update(u, body ?? {});
  }

  @Get('users')
  @Roles(...MANAGERS)
  users(@CurrentUser() u: AuthUser) {
    return this.ops.listUsers(u.operatorId);
  }

  @Post('users')
  @Roles(UserRole.ADMIN)
  createUser(@CurrentUser() u: AuthUser, @Body() body: Record<string, string>) {
    return this.ops.createUser(u.operatorId, body ?? {});
  }

  /** UTL: modif AJO (add), SUP (remove) or VAL (check). */
  @Post('users/:id/register')
  @HttpCode(200)
  @Roles(UserRole.ADMIN)
  register(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: { modif?: Modif }) {
    const modif = body?.modif ?? 'AJO';
    if (!['AJO', 'SUP', 'VAL'].includes(modif)) throw new BadRequestException('modif must be AJO, SUP or VAL');
    return this.ops.registerSevUser(u.operatorId, id, modif);
  }
}
