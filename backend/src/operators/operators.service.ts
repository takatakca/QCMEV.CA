/**
 * Operators Service
 *
 * Manages Operator accounts — the top-level entity representing a business
 * registered with Revenu Québec's MEV-WEB system.
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class OperatorsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: {
    name: string;
    neq: string;
    authorizationCode: string;
    sector: string;
    address?: string;
    mevEnvironment?: string;
  }) {
    return this.prisma.operator.create({
      data: {
        name:              data.name,
        neq:               data.neq,
        authorizationCode: data.authorizationCode,
        sector:            data.sector as any,
        address:           data.address,
        mevEnvironment:    (data.mevEnvironment ?? 'SIMULATOR') as any,
        sevVersion:        '1.0.0',
      },
    });
  }

  async findById(id: string) {
    return this.prisma.operator.findUnique({ where: { id }, include: { devices: true } });
  }

  async update(id: string, data: Partial<{ name: string; address: string; mevEnvironment: string }>) {
    return this.prisma.operator.update({ where: { id }, data: data as any });
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
