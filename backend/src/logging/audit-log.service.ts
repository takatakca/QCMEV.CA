/**
 * Audit Log Service
 * Records all system events for MEV compliance and security auditing.
 * SW-76 §4 requires comprehensive audit trails.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditEventType, LogSeverity } from '@prisma/client';

export interface AuditLogEntry {
  operatorId?: string;
  eventType: AuditEventType;
  severity: LogSeverity;
  userId?: string;
  deviceId?: string;
  entityId?: string;
  entityType?: string;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          operatorId:  entry.operatorId,
          eventType:   entry.eventType,
          severity:    entry.severity,
          userId:      entry.userId,
          deviceId:    entry.deviceId,
          entityId:    entry.entityId,
          entityType:  entry.entityType,
          description: entry.description,
          metadata:    entry.metadata as object,
          ipAddress:   entry.ipAddress,
        },
      });
    } catch (err) {
      // Audit log failures should never crash the app
      this.logger.error(`Failed to write audit log: ${err}`);
    }
  }

  async findAll(operatorId: string, filters?: { eventType?: AuditEventType; severity?: LogSeverity; from?: Date; to?: Date }) {
    return this.prisma.auditLog.findMany({
      where: {
        operatorId,
        ...(filters?.eventType && { eventType: filters.eventType }),
        ...(filters?.severity && { severity: filters.severity }),
        ...(filters?.from || filters?.to) && {
          createdAt: {
            ...(filters.from && { gte: filters.from }),
            ...(filters.to && { lte: filters.to }),
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
  }
}
