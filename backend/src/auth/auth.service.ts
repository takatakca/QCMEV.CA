import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { AuditEventType, LogSeverity } from '@prisma/client';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditLog: AuditLogService,
  ) {}

  async login(username: string, password: string) {
    const user = await this.prisma.sEVUser.findFirst({ where: { username } });
    if (!user || !user.passwordHash) throw new UnauthorizedException('Invalid credentials');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await this.auditLog.log({ operatorId: user.operatorId, eventType: AuditEventType.USER_LOGIN_FAILED, severity: LogSeverity.WARNING, userId: user.id, description: `Failed login attempt for ${username}` });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) throw new UnauthorizedException('Account disabled');

    await this.prisma.sEVUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.auditLog.log({ operatorId: user.operatorId, eventType: AuditEventType.USER_LOGIN, severity: LogSeverity.INFO, userId: user.id, description: `User ${username} logged in` });

    const token = this.jwtService.sign({ sub: user.id, operatorId: user.operatorId, role: user.role });
    return { accessToken: token, user: { id: user.id, username: user.username, role: user.role, operatorId: user.operatorId } };
  }

  async createUser(operatorId: string, data: { username: string; password: string; firstName: string; lastName: string; role: string }) {
    const hash = await bcrypt.hash(data.password, 12);
    return this.prisma.sEVUser.create({
      data: { operatorId, username: data.username, passwordHash: hash, firstName: data.firstName, lastName: data.lastName, role: data.role as any },
    });
  }
}
