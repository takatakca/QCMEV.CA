/**
 * Devices Service
 *
 * Manages SEV devices registered under an operator.
 * Each device has its own hash chain and can independently go offline.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  async register(operatorId: string, data: {
    name: string;
    serialNumber: string;
    deviceType: string;
    model?: string;
    firmwareVersion?: string;
  }) {
    return this.prisma.device.create({
      data: {
        operatorId,
        name:            data.name,
        serialNumber:    data.serialNumber,
        deviceType:      data.deviceType as any,
        model:           data.model,
        firmwareVersion: data.firmwareVersion,
      },
    });
  }

  async findAllForOperator(operatorId: string) {
    return this.prisma.device.findMany({
      where: { operatorId },
      include: { _count: { select: { transactions: true, offlineQueue: true } } },
    });
  }

  async findById(id: string) {
    return this.prisma.device.findUnique({
      where: { id },
      include: {
        _count: { select: { transactions: true } },
        offlineQueue: { where: { status: 'PENDING' }, select: { id: true } },
      },
    });
  }

  async update(id: string, data: Partial<{ name: string; firmwareVersion: string; isActive: boolean }>) {
    return this.prisma.device.update({ where: { id }, data: data as any });
  }

  async getOfflineStatus(deviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    const queueSize = await this.prisma.offlineQueue.count({ where: { deviceId, status: 'PENDING' } });
    return { offlineMode: device?.offlineMode, offlineSince: device?.offlineSince, pendingCount: queueSize };
  }
}
