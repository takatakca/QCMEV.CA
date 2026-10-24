/**
 * Audit trail (who did what, when). Metadata is redacted before it is written.
 */
import { Injectable, Logger } from '@nestjs/common';
import { AuditEventType, LogSeverity, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { redact, safeErrorMessage } from '../common/redact';

export interface AuditLogEntry {
  operatorId?: string | null;
  eventType: AuditEventType;
  severity?: LogSeverity;
  userId?: string | null;
  deviceId?: string | null;
  entityId?: string | null;
  entityType?: string | null;
  description: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string | null;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  async log(entry: AuditLogEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          operatorId: entry.operatorId ?? null,
          eventType: entry.eventType,
          severity: entry.severity ?? LogSeverity.INFO,
          userId: entry.userId ?? null,
          deviceId: entry.deviceId ?? null,
          entityId: entry.entityId ?? null,
          entityType: entry.entityType ?? null,
          description: redact(entry.description),
          metadata: entry.metadata ? (redact(entry.metadata) as Prisma.InputJsonValue) : undefined,
          ipAddress: entry.ipAddress ?? null,
        },
      });
      if (entry.severity === LogSeverity.CRITICAL || entry.severity === LogSeverity.ERROR) {
        this.logger.warn(`${entry.eventType}: ${redact(entry.description)}`);
      }
    } catch (err) {
      this.logger.error(`audit write failed: ${safeErrorMessage(err)}`);
    }
  }

  async findAll(operatorId: string, take = 200) {
    return this.prisma.auditLog.findMany({ where: { operatorId }, orderBy: { createdAt: 'desc' }, take: Math.min(take, 500) });
  }
}
