/**
 * Offline Queue Service
 *
 * Manages the offline transaction queue per SW-76 §4.7.
 * When MEV-WEB is unreachable, transactions are queued locally
 * and re-submitted in chronological order when connectivity resumes.
 *
 * Device state rules:
 *  - offlineSince = moment the device lost MEV-WEB (null while online)
 *  - lastSyncAt   = last moment the device was fully in sync with MEV-WEB
 *  - A device only goes back online once its queue is completely drained.
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { MevWebService } from '../mev-web/mev-web.service';
import { AuditLogService } from '../logging/audit-log.service';
import { AuditEventType, LogSeverity, MevRequestType, QueueStatus } from '@prisma/client';

@Injectable()
export class OfflineQueueService {
  private readonly logger = new Logger(OfflineQueueService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mevWebService: MevWebService,
    private readonly auditLog: AuditLogService,
  ) {}

  async enqueue(
    deviceId: string,
    requestType: MevRequestType,
    payload: object,
    transactionId?: string,
  ) {
    return this.prisma.offlineQueue.create({
      data: { deviceId, requestType, payload, transactionId },
    });
  }

  async getQueueSize(deviceId: string): Promise<number> {
    return this.prisma.offlineQueue.count({ where: { deviceId, status: QueueStatus.PENDING } });
  }

  /** Put a device in offline mode. No-op if it is already offline (keeps the original offlineSince). */
  async activateOfflineMode(deviceId: string, reason?: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.offlineMode) return;

    const now = new Date();
    await this.prisma.device.update({
      where: { id: deviceId },
      data:  { offlineMode: true, offlineSince: now },
    });

    await this.auditLog.log({
      operatorId:  device.operatorId,
      eventType:   AuditEventType.OFFLINE_MODE_ACTIVATED,
      severity:    LogSeverity.WARNING,
      deviceId,
      description: `Appareil ${device.serialNumber} en mode hors ligne${reason ? ` — ${reason}` : ''}`,
      metadata:    { offlineSince: now.toISOString(), reason },
    });
    this.logger.warn(`Device ${deviceId} entered offline mode${reason ? `: ${reason}` : ''}`);
  }

  /** Bring a device back online. Only call once its queue is fully drained. */
  async deactivateOfflineMode(deviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || !device.offlineMode) return;

    const now = new Date();
    const offlineDurationMs = device.offlineSince ? now.getTime() - device.offlineSince.getTime() : null;

    await this.prisma.device.update({
      where: { id: deviceId },
      data:  { offlineMode: false, offlineSince: null, lastSyncAt: now },
    });

    await this.auditLog.log({
      operatorId:  device.operatorId,
      eventType:   AuditEventType.OFFLINE_MODE_DEACTIVATED,
      severity:    LogSeverity.INFO,
      deviceId,
      description: `Appareil ${device.serialNumber} de retour en ligne`,
      metadata:    {
        offlineSince:      device.offlineSince?.toISOString() ?? null,
        backOnlineAt:      now.toISOString(),
        offlineDurationMs,
      },
    });
    this.logger.log(`Device ${deviceId} back online`);
  }

  /** Drain queue for a specific device. Called when connectivity is restored. */
  async flushDeviceQueue(deviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) return;

    const isOnline = await this.mevWebService.checkMevWebConnectivity(device.operatorId);
    if (!isOnline) return;

    const result = await this.mevWebService.submitOfflineBatch(deviceId);

    if (result.submitted > 0 || result.failed > 0) {
      await this.auditLog.log({
        operatorId:  device.operatorId,
        eventType:   AuditEventType.BATCH_SUBMITTED,
        severity:    result.failed > 0 ? LogSeverity.WARNING : LogSeverity.INFO,
        deviceId,
        description: `File hors ligne transmise: ${result.submitted} soumises, ${result.failed} rejetées, ${result.remaining} en attente`,
        metadata:    result,
      });
    }

    // Only go back online when nothing is left to send (preserves chronological order)
    if (result.remaining === 0) {
      await this.deactivateOfflineMode(deviceId);
    }

    return result;
  }

  /** Periodic check every 5 minutes for devices in offline mode */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkOfflineDevices() {
    const offlineDevices = await this.prisma.device.findMany({ where: { offlineMode: true } });
    for (const device of offlineDevices) {
      try {
        await this.flushDeviceQueue(device.id);
      } catch (err) {
        this.logger.warn(
          `Offline flush failed for device ${device.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}
