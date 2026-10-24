import { Injectable, NotFoundException } from '@nestjs/common';
import { CertificateType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { renderReceipt, RenderedReceipt } from './receipt-renderer';

export interface ReceiptObject extends RenderedReceipt {
  qcmevTransactionId: string;
  noTrans: string;
  datTrans: string;
  utc: string;
  deviceId: string;
  mevStatus: string;
  mevProcessedAt: string | null;
  mevTransactionNumber: string | null;
  issuedAt: string;
}

@Injectable()
export class ReceiptService {
  constructor(private readonly prisma: PrismaService) {}

  async build(transactionId: string, operatorId?: string): Promise<ReceiptObject> {
    const tx = await this.prisma.transaction.findFirst({
      where: { id: transactionId, ...(operatorId ? { operatorId } : {}) },
      include: { items: { orderBy: { sortOrder: 'asc' } }, operator: true, device: true, related: true },
    });
    if (!tx) throw new NotFoundException('Transaction not found');
    const cert = await this.prisma.certificate.findFirst({
      where: { deviceId: tx.deviceId, type: CertificateType.SEV, createdAt: { lte: tx.createdAt } },
      orderBy: { createdAt: 'desc' },
    });
    const certificateInvalid = !cert || (!!cert.validUntil && cert.validUntil.getTime() < tx.createdAt.getTime()) || (!!cert.revokedAt && cert.revokedAt.getTime() < tx.createdAt.getTime());
    const rendered = await renderReceipt({
      merchant: { name: tx.operator.name, address: tx.operator.address, city: tx.operator.city, noTPS: tx.operator.noTPS, noTVQ: tx.operator.noTVQ },
      documentKind: tx.documentKind,
      typTrans: tx.transactionType,
      modImpr: tx.printMode,
      formImpr: tx.printFormat,
      modTrans: tx.transactionMode,
      typServ: tx.serviceType,
      modPai: tx.paymentMode,
      noTrans: tx.noTrans,
      datTrans: tx.datTrans,
      utc: tx.utcOffset,
      deviceId: tx.device.mevDeviceId ?? tx.device.serialNumber,
      externalRef: tx.externalRef,
      lines: tx.items.map((i) => ({ description: i.description, quantity: i.quantity, unitPriceCents: i.unitPriceCents, totalCents: i.totalCents, tax: i.tax, isModifier: i.isModifier })),
      subtotalCents: tx.subtotalCents,
      tpsCents: tx.tpsCents,
      tvqCents: tx.tvqCents,
      totalCents: tx.totalCents,
      tipCents: tx.tipCents,
      reference: tx.related ? { noTrans: tx.related.noTrans, datTrans: tx.related.datTrans } : null,
      mevStatus: tx.mevStatus,
      mevTransactionNumber: tx.mevTransactionNumber,
      certificateInvalid,
      qrContent: tx.qrContent ?? '',
    });
    return {
      qcmevTransactionId: tx.id,
      noTrans: tx.noTrans,
      datTrans: tx.datTrans,
      utc: tx.utcOffset,
      deviceId: tx.device.mevDeviceId ?? '',
      mevStatus: tx.mevStatus,
      mevProcessedAt: tx.mevProcessedAt,
      mevTransactionNumber: tx.mevTransactionNumber,
      issuedAt: tx.invoicedAt.toISOString(),
      ...rendered,
    };
  }
}
