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

import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { AuditEventType, LogSeverity } from '@prisma/client';
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

  /**
   * Create a new SEV user and register them with MEV-WEB (UTL request).
   *
   * Per SW-76 §3.4, every SEV operator user must be declared to MEV-WEB
   * before they can initiate certified transactions. This method:
   *  1. Creates the user record in PostgreSQL.
   *  2. Submits a UTL request to MEV-WEB.
   *  3. Saves the returned identifiantUtilisateur as mevUserId.
   *
   * If the UTL request fails (e.g., operator has no active certificate yet
   * during initial setup), the error is logged but user creation still
   * succeeds — the mevUserId will be null until manually re-submitted.
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
  ) {
    // 1. Hash password and create the DB record
    const hash = await bcrypt.hash(data.password, 12);
    const user = await this.prisma.sEVUser.create({
      data: {
        operatorId,
        username:     data.username,
        passwordHash: hash,
        firstName:    data.firstName,
        lastName:     data.lastName,
        role:         data.role as any,
      },
    });

    // 2. Fetch operator for NEQ + authorization code + sector (needed by UTL)
    try {
      const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
      if (!operator) {
        this.logger.warn(`UTL skipped — operator ${operatorId} not found`);
        return user;
      }

      // 3. Build the UTL payload (SW-11 §4.2)
      const utlPayload = {
        entete: {} as any, // signAndPrepare fills this in MevWebService
        corps: {
          neq:               operator.neq,
          codeAutorisation:  operator.authorizationCode,
          secteur:           operator.sector as any,
          prenomUtilisateur: data.firstName,
          nomUtilisateur:    data.lastName,
          roleUtilisateur:   ROLE_TO_MEV[data.role.toUpperCase()] ?? 'CAISSIER',
        },
      };

      // 4. Submit UTL to MEV-WEB
      const utlResponse = await this.mevWebService.submitUserRequest(operatorId, utlPayload);

      // 5. Persist the identifiantUtilisateur returned by MEV-WEB
      if (utlResponse?.identifiantUtilisateur) {
        await this.prisma.sEVUser.update({
          where: { id: user.id },
          data:  { mevUserId: utlResponse.identifiantUtilisateur },
        });
        this.logger.log(
          `UTL registered — user ${user.username} → identifiantUtilisateur ${utlResponse.identifiantUtilisateur}`,
        );
        return { ...user, mevUserId: utlResponse.identifiantUtilisateur };
      }
    } catch (err: any) {
      // Non-fatal: user is created, UTL will need to be re-submitted later
      this.logger.warn(
        `UTL submission failed for user ${data.username} (operator ${operatorId}): ${err?.message ?? err}. ` +
        'User created without mevUserId — re-submit UTL after certificate is active.',
      );
      await this.auditLog.log({
        operatorId,
        eventType:   AuditEventType.MEV_SUBMISSION_FAILED,
        severity:    LogSeverity.WARNING,
        description: `UTL submission failed for user ${data.username}: ${err?.message ?? err}`,
      });
    }

    return user;
  }
}
