/**
 * Offline mode, both halves:
 *  - flush: every MEV_OFFLINE_FLUSH_SECONDS the waiting transactions of each device are sent again (transLot);
 *  - watchdog (48-hour legal limit, R17): a transaction still unsent after 6 h raises a WARNING, after 24 h a
 *    CRITICAL alert, after 48 h a CRITICAL "deadline passed" alert. Alerts go to the audit log (and the server log).
 */
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuditEventType, LogSeverity, MevStatus } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { safeErrorMessage } from '../common/redact';
import { AuditLogService } from '../logging/audit-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';

const HOUR = 3600_000;
export const DEADLINE_LEVELS = [
  { hours: 48, severity: LogSeverity.CRITICAL, label: 'the 48-hour limit has passed' },
  { hours: 24, severity: LogSeverity.CRITICAL, label: 'unsent for 24 h (limit: 48 h)' },
  { hours: 6, severity: LogSeverity.WARNING, label: 'unsent for 6 h (limit: 48 h)' },
] as const;

export function deadlineLevel(createdAt: Date, now = Date.now()): (typeof DEADLINE_LEVELS)[number] | null {
  const age = now - createdAt.getTime();
  return DEADLINE_LEVELS.find((l) => age >= l.hours * HOUR) ?? null;
}

@Injectable()
export class OfflineWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Offline');
  private timers: NodeJS.Timeout[] = [];
  private readonly alerted = new Map<string, number>();
  private running = false;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly txs: TransactionsService,
    private readonly audit: AuditLogService,
  ) {}

  onModuleInit(): void {
    if (this.cfg.offlineFlushSeconds > 0) {
      this.timers.push(setInterval(() => void this.flush(), this.cfg.offlineFlushSeconds * 1000));
      this.timers.push(setInterval(() => void this.watchdog(), 10 * 60_000));
      this.timers.forEach((t) => t.unref());
    }
  }

  onModuleDestroy(): void {
    this.timers.forEach((t) => clearInterval(t));
  }

  async flush(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await this.txs.flushAll();
    } catch (e) {
      this.logger.warn(`flush failed: ${safeErrorMessage(e)}`);
      return 0;
    } finally {
      this.running = false;
    }
  }

  async watchdog(now = Date.now()): Promise<number> {
    const waiting = await this.prisma.transaction.findMany({
      where: { mevStatus: { in: [MevStatus.PENDING, MevStatus.OFFLINE_PENDING, MevStatus.RETRY_BATCH] }, createdAt: { lte: new Date(now - 6 * HOUR) } },
      select: { id: true, operatorId: true, deviceId: true, noTrans: true, createdAt: true },
      take: 500,
    });
    let raised = 0;
    for (const t of waiting) {
      const level = deadlineLevel(t.createdAt, now);
      if (!level || (this.alerted.get(t.id) ?? 0) >= level.hours) continue;
      this.alerted.set(t.id, level.hours);
      raised++;
      await this.audit.log({
        operatorId: t.operatorId,
        eventType: AuditEventType.OFFLINE_DEADLINE_WARNING,
        severity: level.severity,
        deviceId: t.deviceId,
        entityId: t.id,
        entityType: 'Transaction',
        description: `transaction ${t.noTrans}: ${level.label}`,
      });
    }
    return raised;
  }

  async status(operatorIds?: string[]) {
    const where = { status: 'PENDING' as const, ...(operatorIds ? { device: { operatorId: { in: operatorIds } } } : {}) };
    const [queueDepth, oldest] = await Promise.all([
      this.prisma.offlineQueue.count({ where }),
      this.prisma.offlineQueue.findFirst({ where, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
    ]);
    return { queueDepth, oldestQueuedAt: oldest?.createdAt ?? null };
  }
}
