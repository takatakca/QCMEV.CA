/**
 * Devices Service
 *
 * Manages SEV devices registered under an operator.
 * Each device has its own hash chain and can independently go offline.
 */

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DeviceType } from '@prisma/client';
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
    description?: string;
  }) {
    if (!Object.values(DeviceType).includes(data.deviceType as DeviceType)) {
      throw new BadRequestException(
        `Invalid deviceType "${data.deviceType}". Expected one of: ${Object.values(DeviceType).join(', ')}`,
      );
    }
    return this.prisma.device.create({
      data: {
        operatorId,
        name:            data.name,
        serialNumber:    data.serialNumber,
        deviceType:      data.deviceType as DeviceType,
        model:           data.model,
        firmwareVersion: data.firmwareVersion,
        description:     data.description,
      },
    });
  }

  async findAllForOperator(operatorId: string) {
    return this.prisma.device.findMany({
      where: { operatorId },
      include: { _count: { select: { transactions: true, offlineQueue: true } } },
    });
  }

  /** Tenant isolation: 404 unless the device belongs to this operator */
  async assertOwned(operatorId: string, deviceId: string) {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, operatorId }, select: { id: true } });
    if (!device) throw new NotFoundException('Device not found');
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

  async update(id: string, data: Partial<{
    name: string;
    model: string;
    firmwareVersion: string;
    description: string;
    isActive: boolean;
  }>) {
    const existing = await this.prisma.device.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Device not found');
    // Explicit whitelist — never pass arbitrary client fields to Prisma
    return this.prisma.device.update({
      where: { id },
      data: {
        name:            data.name,
        model:           data.model,
        firmwareVersion: data.firmwareVersion,
        description:     data.description,
        isActive:        data.isActive,
      },
    });
  }

  async getOfflineStatus(deviceId: string) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    const queueSize = await this.prisma.offlineQueue.count({ where: { deviceId, status: 'PENDING' } });
    if (!device) throw new NotFoundException('Device not found');
    return {
      offlineMode:  device.offlineMode,
      offlineSince: device.offlineSince,
      lastSyncAt:   device.lastSyncAt,
      pendingCount: queueSize,
    };
  }
}
