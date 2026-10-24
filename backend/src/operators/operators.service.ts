/**
 * Operators Service
 *
 * Manages Operator accounts — the top-level entity representing a business
 * registered with Revenu Québec's MEV-WEB system.
 */

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { AuditEventType, LogSeverity, MevEnvironment, Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../logging/audit-log.service';
import { RegisterOperatorDto, UpdateOperatorDto } from './dto/register-operator.dto';

@Injectable()
export class OperatorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Register a new operator + its first ADMIN user atomically (one nested insert):
   * either both exist afterwards or neither does. No MEV-WEB call here — the
   * operator has no certificate yet. The admin's UTL is sent automatically once
   * the first certificate is stored (CertificateLifecycleService → syncMevUsers).
   */
  async register(dto: RegisterOperatorDto) {
    const neqTaken = await this.prisma.operator.findUnique({ where: { neq: dto.neq } });
    if (neqTaken) throw new ConflictException(`An operator with NEQ ${dto.neq} is already registered`);
    const userTaken = await this.prisma.sEVUser.findUnique({ where: { username: dto.adminUsername } });
    if (userTaken) throw new ConflictException(`Username "${dto.adminUsername}" is already taken`);

    const passwordHash = await bcrypt.hash(dto.adminPassword, 12);

    try {
      const operator = await this.prisma.operator.create({
        data: {
          name:              dto.name,
          neq:               dto.neq,
          sector:            dto.sector,
          authorizationCode: dto.authorizationCode,
          environment:       dto.environment ?? MevEnvironment.SIMULATOR,
          address:           dto.address,
          city:              dto.city,
          postalCode:        dto.postalCode,
          phone:             dto.phone,
          email:             dto.email,
          sevVersion:        '1.0.0',
          users: {
            create: {
              username:     dto.adminUsername,
              passwordHash,
              firstName:    dto.adminFirstName ?? 'Admin',
              lastName:     dto.adminLastName ?? '',
              role:         UserRole.ADMIN,
            },
          },
        },
        include: { users: { select: { id: true, username: true, role: true } } },
      });

      const admin = operator.users[0];
      await this.auditLog.log({
        operatorId:  operator.id,
        eventType:   AuditEventType.USER_REGISTERED,
        severity:    LogSeverity.INFO,
        userId:      admin.id,
        entityId:    operator.id,
        entityType:  'Operator',
        description: `Exploitant ${operator.name} (NEQ ${operator.neq}) enregistré avec l'administrateur ${admin.username}`,
      });

      return { operator, admin };
    } catch (err) {
      // Race on the unique constraints between the checks above and the insert
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('NEQ or admin username already registered');
      }
      throw err;
    }
  }

  async findById(id: string) {
    const operator = await this.prisma.operator.findUnique({ where: { id }, include: { devices: true } });
    if (!operator) throw new NotFoundException('Operator not found');
    return operator;
  }

  /** Explicit whitelist — NEQ, sector, SEV certification code etc. are never client-editable */
  async update(id: string, dto: UpdateOperatorDto) {
    return this.prisma.operator.update({
      where: { id },
      data: {
        name:              dto.name,
        authorizationCode: dto.authorizationCode,
        address:           dto.address,
        city:              dto.city,
        postalCode:        dto.postalCode,
        phone:             dto.phone,
        email:             dto.email,
        tpsNumber:         dto.tpsNumber,
        tvqNumber:         dto.tvqNumber,
        environment:       dto.environment,
      },
    });
  }

  async getMevStatus(operatorId: string) {
    const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    const activeCert = await this.prisma.certificate.findFirst({
      where: { operatorId, isActive: true, validTo: { gte: new Date() } },
    });
    const offlineDevices = await this.prisma.device.count({ where: { operatorId, offlineMode: true } });
    const pendingQueue  = await this.prisma.offlineQueue.count({ where: { device: { operatorId }, status: 'PENDING' } });

    return {
      operator,
      hasCertificate: !!activeCert,
      certificateExpiry: activeCert?.validTo,
      offlineDeviceCount: offlineDevices,
      pendingQueueSize: pendingQueue,
    };
  }
}
