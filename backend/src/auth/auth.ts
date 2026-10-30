/**
 * Staff authentication: JWT (one payload shape everywhere: sub = SEVUser id, operatorId, role) and role checks.
 * System users (FOODHUB-AUTO) have no password and can never log in.
 */
import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Post,
  SetMetadata,
  UnauthorizedException,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthGuard, PassportStrategy } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { LOGIN_THROTTLE } from '../common/throttle';
import { AuditEventType, LogSeverity, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { AuditLogService } from '../logging/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';

export interface JwtPayload {
  sub: string;
  operatorId: string;
  role: UserRole;
}

export interface AuthUser {
  sub: string;
  operatorId: string;
  role: UserRole;
}

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(@Inject(APP_CONFIG) cfg: AppConfig, private readonly prisma: PrismaService) {
    super({ jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(), ignoreExpiration: false, secretOrKey: cfg.jwtSecret });
  }

  async validate(payload: JwtPayload): Promise<AuthUser> {
    const user = await this.prisma.sEVUser.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive || !user.passwordHash || user.operatorId !== payload.operatorId) throw new UnauthorizedException();
    return { sub: user.id, operatorId: user.operatorId, role: user.role };
  }
}

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

export const ROLES_KEY = 'roles';
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [ctx.getHandler(), ctx.getClass()]);
    if (!roles?.length) return true;
    const user = ctx.switchToHttp().getRequest().user as AuthUser | undefined;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException('Your role cannot do this');
    return true;
  }
}

export const MANAGERS = [UserRole.ADMIN, UserRole.MANAGER];
export const STAFF = [UserRole.ADMIN, UserRole.MANAGER, UserRole.CASHIER];

@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(private readonly prisma: PrismaService, private readonly jwt: JwtService, private readonly audit: AuditLogService) {}

  async login(username: string, password: string) {
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) throw new UnauthorizedException('Invalid credentials');
    const user = await this.prisma.sEVUser.findUnique({ where: { username } });
    const ok = !!user?.passwordHash && user.isActive && (await bcrypt.compare(password, user.passwordHash));
    if (!user || !ok) {
      if (user) await this.audit.log({ operatorId: user.operatorId, eventType: AuditEventType.AUTH_LOGIN_FAILED, severity: LogSeverity.WARNING, userId: user.id, description: 'failed login' });
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.prisma.sEVUser.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ operatorId: user.operatorId, eventType: AuditEventType.AUTH_LOGIN, userId: user.id, description: 'login' });
    const payload: JwtPayload = { sub: user.id, operatorId: user.operatorId, role: user.role };
    return { accessToken: this.jwt.sign(payload), user: { id: user.id, username: user.username, role: user.role, operatorId: user.operatorId } };
  }

  static hash(password: string): Promise<string> {
    if (!password || password.length < 12) throw new Error('password must be at least 12 characters');
    return bcrypt.hash(password, 12);
  }
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(200)
  @Throttle(LOGIN_THROTTLE)
  login(@Body() body: { username?: string; password?: string }) {
    return this.auth.login(String(body?.username ?? ''), String(body?.password ?? ''));
  }
}
