/**
 * Operators (the legal business), their settings and their SEV users (UTL).
 *
 *  - register(): PUBLIC first-time setup (POST /api/operators/register): the operator and its first ADMIN are created
 *    in ONE nested insert (both or neither), 409 on a duplicate NEQ or username. No MEV-WEB call: there is no
 *    certificate yet. The admin is registered with UTL automatically once a device gets its certificate.
 *    Can be turned off with QCMEV_PUBLIC_REGISTRATION=false (then only `npm run seed:operator` creates operators).
 *  - registerSevUser(): UTL request (modif AJO / SUP / VAL) signed by each certified device of the operator; the
 *    user's nomUtil is marked registered once MEV-WEB accepts it on every device.
 *  - syncMevUsers(): sends UTL AJO for every active user not registered yet (no-op when all are).
 * Never returns identity values, password hashes or authorization codes.
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Injectable,
  NotFoundException,
  Param,
  Post,
  Put,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { REGISTER_THROTTLE } from '../common/throttle';
import { AuditEventType, CertificateType, LogSeverity, MevEnvironment, Prisma, UserRole } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AuthService, AuthUser, CurrentUser, JwtAuthGuard, MANAGERS, Roles, RolesGuard } from '../auth/auth';
import { CreateUserDto, UtlDto } from '../auth/dto/create-user.dto';
import { CertificatesService } from '../certificates/certificates.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MevWebService } from '../mev-web/mev-web.service';
import { classifyErrors, MevError, Modif } from '../mev-web/mev-web.types';
import { PrismaService } from '../prisma/prisma.service';
import { NOM_UTIL, RegisterOperatorDto, UpdateOperatorDto } from './dto/register-operator.dto';

function defaultNomUtil(first: string | undefined, last: string | undefined, username: string): string {
  const full = `${first ?? ''} ${last ?? ''}`.trim();
  return NOM_UTIL.test(full) ? full : username;
}

@Injectable()
export class OperatorsService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly certificates: CertificatesService,
    private readonly mevWeb: MevWebService,
    private readonly audit: AuditLogService,
  ) {}

  /** Public first-time setup: operator + first ADMIN, atomically. */
  async register(dto: RegisterOperatorDto) {
    if (!this.cfg.publicRegistration) throw new ForbiddenException('Self-registration is turned off on this server (QCMEV_PUBLIC_REGISTRATION=false)');
    if (dto.environment && dto.environment !== this.cfg.mevEnvironment) {
      throw new BadRequestException(`The server runs ${this.cfg.mevEnvironment}; an operator can only be set up for it`);
    }
    if (await this.prisma.operator.findUnique({ where: { neq: dto.neq }, select: { id: true } })) throw new ConflictException('An operator with this NEQ is already registered');
    if (await this.prisma.sEVUser.findUnique({ where: { username: dto.adminUsername }, select: { id: true } })) throw new ConflictException(`Username "${dto.adminUsername}" is already taken`);
    const mevUserName = dto.adminMevUserName ?? defaultNomUtil(dto.adminFirstName, dto.adminLastName, dto.adminUsername);
    if (!NOM_UTIL.test(mevUserName)) throw new BadRequestException('adminMevUserName: 2–50 characters');
    const passwordHash = await AuthService.hash(dto.adminPassword);
    try {
      const operator = await this.prisma.operator.create({
        data: {
          name: dto.name.trim(),
          neq: dto.neq,
          noTPS: dto.noTPS,
          noTVQ: dto.noTVQ,
          sector: 'RBC',
          address: dto.address,
          city: dto.city,
          postalCode: dto.postalCode,
          phone: dto.phone,
          email: dto.email,
          environment: this.cfg.mevEnvironment as MevEnvironment,
          users: {
            create: {
              username: dto.adminUsername,
              passwordHash,
              firstName: dto.adminFirstName ?? 'Admin',
              lastName: dto.adminLastName ?? '',
              role: UserRole.ADMIN,
              mevUserName,
            },
          },
        },
        select: { id: true, name: true, environment: true, users: { select: { id: true, username: true, role: true, mevUserName: true } } },
      });
      const admin = operator.users[0];
      await this.audit.log({
        operatorId: operator.id,
        eventType: AuditEventType.USER_REGISTERED,
        userId: admin.id,
        entityId: operator.id,
        entityType: 'Operator',
        description: `operator registered with its first admin ${admin.username}`,
      });
      return { operator: { id: operator.id, name: operator.name, environment: operator.environment }, admin };
    } catch (e) {
      // Race on the unique constraints between the checks above and the insert.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('NEQ or admin username already registered');
      throw e;
    }
  }

  async me(operatorId: string) {
    const op = await this.prisma.operator.findUnique({
      where: { id: operatorId },
      select: { id: true, name: true, sector: true, address: true, city: true, province: true, postalCode: true, phone: true, email: true, environment: true, createdAt: true },
    });
    if (!op) throw new NotFoundException('Operator not found');
    return { ...op, serverEnvironment: this.cfg.mevEnvironment, certified: this.cfg.certified };
  }

  /** Whitelisted fields only (UpdateOperatorDto). Environment and tax numbers: ADMIN only, with their own rules. */
  async update(user: AuthUser, body: UpdateOperatorDto) {
    const data: Prisma.OperatorUpdateInput = {};
    for (const k of ['name', 'address', 'city', 'postalCode', 'phone', 'email'] as const) {
      if (typeof body[k] === 'string') data[k] = (body[k] as string).trim().slice(0, 200);
    }
    if (body.noTPS !== undefined || body.noTVQ !== undefined) {
      if (user.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change the tax numbers');
      const certified = await this.prisma.certificate.count({ where: { operatorId: user.operatorId, type: CertificateType.SEV, isActive: true } });
      if (certified) throw new ConflictException('The tax numbers are inside the device certificates and every signature: they cannot change once a device is certified');
      if (body.noTPS) data.noTPS = body.noTPS;
      if (body.noTVQ) data.noTVQ = body.noTVQ;
    }
    if (body.environment !== undefined) {
      if (user.role !== UserRole.ADMIN) throw new ForbiddenException('Only an admin can change the environment');
      if (body.environment !== this.cfg.mevEnvironment) throw new BadRequestException(`The server runs ${this.cfg.mevEnvironment}; the operator can only be moved to it`);
      if (body.confirm !== `CONFIRM ${body.environment}`) throw new BadRequestException(`Send confirm: "CONFIRM ${body.environment}"`);
      data.environment = body.environment as MevEnvironment;
    }
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to update');
    await this.prisma.operator.update({ where: { id: user.operatorId }, data });
    const sensitive = data.environment !== undefined || data.noTPS !== undefined || data.noTVQ !== undefined;
    await this.audit.log({ operatorId: user.operatorId, eventType: AuditEventType.SETTINGS_CHANGED, severity: sensitive ? LogSeverity.WARNING : LogSeverity.INFO, userId: user.sub, description: `operator settings changed: ${Object.keys(data).join(', ')}` });
    return this.me(user.operatorId);
  }

  async listUsers(operatorId: string) {
    return this.prisma.sEVUser.findMany({
      where: { operatorId },
      select: { id: true, username: true, firstName: true, lastName: true, role: true, mevUserName: true, mevRegisteredAt: true, isActive: true, externalId: true, lastLoginAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** New SEV user, then UTL AJO on every certified device (a failed UTL is non-fatal: syncMevUsers() retries it). */
  async createUser(operatorId: string, body: CreateUserDto) {
    const role = (body.role ?? 'CASHIER') as UserRole;
    if (await this.prisma.sEVUser.findUnique({ where: { username: body.username }, select: { id: true } })) throw new ConflictException(`Username "${body.username}" is already taken`);
    let passwordHash: string;
    try {
      passwordHash = await AuthService.hash(body.password);
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
    const mevUserName = body.mevUserName ?? defaultNomUtil(body.firstName, body.lastName, body.username);
    if (!NOM_UTIL.test(mevUserName)) throw new BadRequestException('mevUserName: 2–50 characters');
    let user;
    try {
      user = await this.prisma.sEVUser.create({
        data: { operatorId, username: body.username, passwordHash, firstName: body.firstName, lastName: body.lastName ?? '', role, mevUserName },
        select: { id: true, username: true, role: true, mevUserName: true },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException(`Username "${body.username}" is already taken`);
      throw e;
    }
    await this.audit.log({ operatorId, eventType: AuditEventType.USER_REGISTERED, userId: user.id, entityId: user.id, entityType: 'SEVUser', description: `SEV user ${user.username} (${role}) created` });
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

  /** After a new certificate, every user with a nomUtil is registered (again) on that device. */
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

  /** UTL AJO for every active user of the operator not registered yet. A second call is a no-op. */
  async syncMevUsers(operatorId: string): Promise<{ registered: string[]; failed: string[] }> {
    const users = await this.prisma.sEVUser.findMany({ where: { operatorId, isActive: true, mevUserName: { not: null }, mevRegisteredAt: null }, orderBy: { createdAt: 'asc' } });
    const registered: string[] = [];
    const failed: string[] = [];
    for (const u of users) {
      try {
        await this.registerSevUser(operatorId, u.id, 'AJO');
        registered.push(u.username);
      } catch {
        failed.push(u.username);
      }
    }
    return { registered, failed };
  }

  async mevStatus(operatorId: string) {
    const [devices, queue, oldest] = await Promise.all([
      this.prisma.device.findMany({ where: { operatorId }, select: { id: true, serialNumber: true, name: true, mevDeviceId: true, offlineMode: true, offlineSince: true, lastSyncAt: true } }),
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

/** PUBLIC: first-time setup. Kept apart from OperatorsController, whose guards apply to every one of its routes. */
@Controller('operators')
export class OperatorRegistrationController {
  constructor(private readonly ops: OperatorsService) {}

  @Post('register')
  @HttpCode(201)
  @Throttle(REGISTER_THROTTLE)
  async register(@Body() dto: RegisterOperatorDto) {
    const { operator, admin } = await this.ops.register(dto);
    return {
      operatorId: operator.id,
      adminUserId: admin.id,
      environment: operator.environment,
      message: 'Opérateur enregistré. Connectez-vous, ajoutez un appareil (numéro de dossier et code d\'autorisation), puis demandez son certificat.',
      nextSteps: ['POST /api/auth/login', 'POST /api/devices', 'POST /api/devices/:id/certificate (CRT, then UTL for every user)'],
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
  update(@CurrentUser() u: AuthUser, @Body() body: UpdateOperatorDto) {
    return this.ops.update(u, body ?? {});
  }

  @Get('users')
  @Roles(...MANAGERS)
  users(@CurrentUser() u: AuthUser) {
    return this.ops.listUsers(u.operatorId);
  }

  @Post('users')
  @Roles(UserRole.ADMIN)
  createUser(@CurrentUser() u: AuthUser, @Body() body: CreateUserDto) {
    return this.ops.createUser(u.operatorId, body);
  }

  /** UTL AJO for every user of this operator not registered with MEV-WEB yet. */
  @Post('users/sync-mev')
  @HttpCode(200)
  @Roles(...MANAGERS)
  syncMev(@CurrentUser() u: AuthUser) {
    return this.ops.syncMevUsers(u.operatorId);
  }

  /** UTL: modif AJO (add), SUP (remove) or VAL (check). */
  @Post('users/:id/register')
  @HttpCode(200)
  @Roles(UserRole.ADMIN)
  register(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() body: UtlDto) {
    return this.ops.registerSevUser(u.operatorId, id, body?.modif ?? 'AJO');
  }
}
