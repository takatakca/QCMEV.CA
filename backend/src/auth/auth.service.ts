/**
 * Auth Service
 *
 * Handles user authentication (login/JWT) and SEV user creation.
 * On user creation, automatically submits a UTL (utilisateur) request
 * to MEV-WEB and stores the assigned identifiantUtilisateur as mevUserId.
 *
 * SW-76 §3.4 — all SEV users must be registered with MEV-WEB before
 * they can authenticate transactions on certified devices.
 */

import { Injectable, UnauthorizedException, Logger, BadRequestException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { AuditEventType, LogSeverity, UserRole } from '@prisma/client';
import { MevRequestTypeCode, SectorCode, UserRequestPayload } from '../mev-web/dto/mev-web.dto';
import { MevWebService } from '../mev-web/mev-web.service';

// Map NestJS/DB role names → MEV-WEB roleUtilisateur values
const ROLE_TO_MEV: Record<string, string> = {
  ADMIN:    'ADMIN',
  MANAGER:  'GERANT',
  CASHIER:  'CAISSIER',
  GERANT:   'GERANT',
  CAISSIER: 'CAISSIER',
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditLog: AuditLogService,
    private readonly mevWebService: MevWebService,
  ) {}

  // ─── Authentication ─────────────────────────────────────────────────────────

  async login(username: string, password: string) {
    const user = await this.prisma.sEVUser.findFirst({ where: { username } });
    if (!user || !user.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await this.auditLog.log({
        operatorId:  user.operatorId,
        eventType:   AuditEventType.USER_LOGIN_FAILED,
        severity:    LogSeverity.WARNING,
        userId:      user.id,
        description: `Failed login attempt for ${username}`,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) throw new UnauthorizedException('Account disabled');

    await this.prisma.sEVUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.auditLog.log({
      operatorId:  user.operatorId,
      eventType:   AuditEventType.USER_LOGIN,
      severity:    LogSeverity.INFO,
      userId:      user.id,
      description: `User ${username} logged in`,
    });

    const token = this.jwtService.sign({ sub: user.id, operatorId: user.operatorId, role: user.role });
    return {
      accessToken: token,
      user: { id: user.id, username: user.username, role: user.role, operatorId: user.operatorId },
    };
  }

  // ─── User Management ────────────────────────────────────────────────────────

  /** Never return the bcrypt hash to API clients */
  private toPublicUser<T extends { passwordHash?: string }>(user: T): Omit<T, 'passwordHash'> {
    const { passwordHash: _omit, ...rest } = user;
    return rest;
  }

  /**
   * Create a new SEV user and register them with MEV-WEB (UTL request, SW-76 §3.4).
   *
   *  1. Validates role + username uniqueness, creates the user in PostgreSQL.
   *  2. Submits a UTL request (unless skipMev — e.g. at operator registration,
   *     before any certificate exists) and stores identifiantUtilisateur.
   *
   * A failed UTL is non-fatal: the user exists with mevUserId = null and is picked
   * up by syncMevUsers() — called automatically once a certificate is stored,
   * or manually via POST /api/operators/users/sync-mev.
   */
  async createUser(
    operatorId: string,
    data: {
      username:  string;
      password:  string;
      firstName: string;
      lastName:  string;
      role:      string;
    },
    opts: { skipMev?: boolean } = {},
  ) {
    const role = String(data.role ?? '').toUpperCase();
    if (!Object.values(UserRole).includes(role as UserRole)) {
      throw new BadRequestException(`Invalid role "${data.role}". Expected one of: ${Object.values(UserRole).join(', ')}`);
    }
    if (!data.username?.trim() || !data.password || data.password.length < 8) {
      throw new BadRequestException('username is required and password must be at least 8 characters');
    }
    const existing = await this.prisma.sEVUser.findUnique({ where: { username: data.username } });
    if (existing) throw new ConflictException(`Username "${data.username}" is already taken`);

    const hash = await bcrypt.hash(data.password, 12);
    const user = await this.prisma.sEVUser.create({
      data: {
        operatorId,
        username:     data.username,
        passwordHash: hash,
        firstName:    data.firstName,
        lastName:     data.lastName ?? '',
        role:         role as UserRole,
      },
    });

    await this.auditLog.log({
      operatorId,
      eventType:   AuditEventType.USER_REGISTERED,
      severity:    LogSeverity.INFO,
      userId:      user.id,
      entityId:    user.id,
      entityType:  'SEVUser',
      description: `Utilisateur ${user.username} (${role}) créé`,
    });

    if (opts.skipMev) return this.toPublicUser(user);

    const mevUserId = await this.registerUserWithMev(user.id);
    return this.toPublicUser({ ...user, mevUserId: mevUserId ?? user.mevUserId });
  }

  /**
   * Send the UTL request for one existing user and persist identifiantUtilisateur.
   * Returns the MEV user id, or null if MEV-WEB refused / was unreachable (logged + audited).
   */
  async registerUserWithMev(userId: string): Promise<string | null> {
    const user = await this.prisma.sEVUser.findUnique({ where: { id: userId }, include: { operator: true } });
    if (!user) return null;
    if (user.mevUserId) return user.mevUserId;
    const operator = user.operator;

    try {
      const utlPayload: UserRequestPayload = {
        entete: this.mevWebService.buildHeader(operator, MevRequestTypeCode.UTL),
        corps: {
          neq:               operator.neq,
          codeAutorisation:  operator.authorizationCode ?? '',
          secteur:           operator.sector as unknown as SectorCode,
          prenomUtilisateur: user.firstName,
          nomUtilisateur:    user.lastName,
          roleUtilisateur:   ROLE_TO_MEV[user.role] ?? 'CAISSIER',
        },
      };

      const utlResponse = await this.mevWebService.submitUserRequest(operator.id, utlPayload);
      if (!utlResponse?.identifiantUtilisateur) {
        throw new Error(`MEV-WEB returned no identifiantUtilisateur (codeRetour ${utlResponse?.codeRetour ?? '?'})`);
      }

      await this.prisma.sEVUser.update({
        where: { id: user.id },
        data:  { mevUserId: utlResponse.identifiantUtilisateur },
      });
      this.logger.log(`UTL registered — ${user.username} → ${utlResponse.identifiantUtilisateur}`);
      return utlResponse.identifiantUtilisateur;
    } catch (err: any) {
      this.logger.warn(
        `UTL failed for ${user.username} (operator ${operator.id}): ${err?.message ?? err} — will retry via syncMevUsers()`,
      );
      await this.auditLog.log({
        operatorId:  operator.id,
        eventType:   AuditEventType.MEV_SUBMISSION_FAILED,
        severity:    LogSeverity.WARNING,
        userId:      user.id,
        description: `UTL submission failed for user ${user.username}: ${err?.message ?? err}`,
      });
      return null;
    }
  }

  /**
   * (Re)send UTL for every active user of the operator that has no mevUserId yet.
   * Without a mevUserId, every TRX for that user is refused (identifiantUtilisateur).
   */
  async syncMevUsers(operatorId: string): Promise<{ registered: string[]; failed: string[] }> {
    const users = await this.prisma.sEVUser.findMany({
      where: { operatorId, isActive: true, mevUserId: null },
      orderBy: { createdAt: 'asc' },
    });
    const registered: string[] = [];
    const failed: string[] = [];
    for (const u of users) {
      const id = await this.registerUserWithMev(u.id);
      (id ? registered : failed).push(u.username);
    }
    return { registered, failed };
  }
}
