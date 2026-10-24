/**
 * Offline Queue Service
 *
 * Manages the offline transaction queue per SW-76 §4.7.
 * When MEV-WEB is unreachable, transactions are queued locally
 * and re-submitted in chronological order when connectivity resumes.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MevWebService } from '../mev-web/mev-web.service';
import { AuditLogService } from '../logging/audit-log.service';
import { AuditEventType, LogSeverity, MevRequestType } from '@prisma/client';

@Injectable()
export class OfflineQueueService {
  private readonly logger = new Logger(OfflineQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mevWebService: MevWebService,
    private readonly auditLog: AuditLogService,
  ) {}

  async enqueue(deviceId: string, requestType: MevRequestType, payload: object) {
    return this.prisma.offlineQueue.create({ data: { deviceId, requestType, payload } });
  }

  async getQueueSize(deviceId: string): Promise<number> {
    return this.prisma.offlineQueue.count({ where: { deviceId, status: 'PENDING' } });
  }

  async activateOfflineMode(deviceId: string) {
    await this.prisma.device.update({ where: { id: deviceId }, data: { offlineMode: true, lastSyncAt: new Date() } });
    this.logger.warn(`Device ${deviceId} entered offline mode`);
  }

  async deactivateOfflineMode(deviceId: string) {
    await this.prisma.device.update({ where: { id: deviceId }, data: { offlineMode: false } });
    this.logger.log(`Device ${deviceId} back online`);
  }

  /** Drain queue for a specific device. Called when connectivity is restored. */
  async flushDeviceQueue(deviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId }, include: { operator: true } });
    if (!device) return;

    const isOnline = await this.mevWebService.checkMevWebConnectivity(device.operatorId);
    if (!isOnline) return;

    const result = await this.mevWebService.submitOfflineBatch(deviceId);
    await this.deactivateOfflineMode(deviceId);

    await this.auditLog.log({
      operatorId: device.operatorId,
      eventType:  AuditEventType.BATCH_SUBMITTED,
      severity:   LogSeverity.INFO,
      deviceId,
      description: `Offline queue flushed: ${result.submitted} soumises, ${result.failed} échecs`,
    });

    return result;
  }

  /** Periodic check every 5 minutes for devices in offline mode */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkOfflineDevices() {
    const offlineDevices = await this.prisma.device.findMany({ where: { offlineMode: true } });
    for (const device of offlineDevices) {
      try {
        await this.flushDeviceQueue(device.id);
      } catch {
        // Keep trying
      }
    }
  }
}
