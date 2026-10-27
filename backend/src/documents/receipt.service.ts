/**
 * Receipt Service
 *
 * Generates formatted receipts per SW-76 §4.3.
 * Includes required mentions, QR code, and certified MEV data.
 */

import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { CertificatesService } from '../certificates/certificates.service';

@Injectable()
export class ReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly certificatesService: CertificatesService,
  ) {}

  async generateReceiptData(transactionId: string) {
    const tx = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { items: true, operator: true, device: true, user: true },
    });
    if (!tx) throw new Error('Transaction not found');

    // Generate QR code image (base64 PNG)
    let qrCodeImage: string | null = null;
    if (tx.qrCodeUrl) {
      const encrypted = await this.certificatesService.encryptQrData(tx.qrCodeUrl);
      qrCodeImage = await QRCode.toDataURL(encrypted, { errorCorrectionLevel: 'M', width: 200 });
    }

    return {
      operator: { name: tx.operator.name, neq: tx.operator.neq, address: tx.operator.address },
      device:   { serialNumber: tx.device.serialNumber },
      transaction: {
        number:           tx.transactionNumber,
        mevNumber:        tx.mevTransactionNumber,
        type:             tx.transactionType,
        civilDate:        tx.civilDate,
        createdAt:        tx.createdAt,
        items:            tx.items,
        subtotal:         Number(tx.subtotal),
        tpsAmount:        Number(tx.tpsAmount),
        tvqAmount:        Number(tx.tvqAmount),
        totalAmount:      Number(tx.totalAmount),
        tipsAmount:       tx.tipsAmount ? Number(tx.tipsAmount) : null,
        paymentMode:      tx.paymentMode,
        tableNumber:      tx.tableNumber,
        numberOfCovers:   tx.numberOfCovers,
      },
      certifiedData: tx.certifiedData,
      qrCodeImage,
      mention: this.getDocumentMention(tx.transactionType as any),
      isTraining: tx.isTraining,
      // SW-76 §4.3 — required mention
      mevMention: tx.mevTransactionNumber
        ? `Numéro MEV: ${tx.mevTransactionNumber}`
        : 'Transaction en attente de certification MEV',
    };
  }

  private getDocumentMention(type: string): string {
    const mentions: Record<string, string> = {
      ADDITION: 'REÇU', CLOSING_RECEIPT: 'FERMETURE DE COMPTE', CREDIT_NOTE: 'NOTE DE CRÉDIT',
      ESTIMATION: 'ESTIMATION', QUOTE: 'SOUMISSION', DUPLICATE: 'DUPLICATA',
      REPRODUCTION: 'REPRODUCTION', CANCELLATION: 'ANNULATION', CORRECTION: 'CORRECTION',
      TRAINING: 'FORMATION (Sans valeur légale)',
    };
    return mentions[type] ?? 'DOCUMENT';
  }

  /** Format receipt as plain text for thermal printer */
  async formatReceiptText(transactionId: string): Promise<string> {
    const data = await this.generateReceiptData(transactionId);
    const lines: string[] = [];
    const line = (s: string) => lines.push(s);
    const divider = () => line('-'.repeat(40));

    if (data.isTraining) line('*** MODE FORMATION — SANS VALEUR LÉGALE ***');
    line(data.mention.padStart(20 + data.mention.length / 2));
    divider();
    line(data.operator.name);
    line(`NEQ: ${data.operator.neq}`);
    line(data.operator.address ?? '');
    divider();
    line(`Date: ${data.transaction.civilDate.slice(0,4)}-${data.transaction.civilDate.slice(4,6)}-${data.transaction.civilDate.slice(6)}`);
    line(`Transaction: ${data.transaction.number}`);
    if (data.transaction.mevNumber) line(`MEV: ${data.transaction.mevNumber}`);
    divider();
    for (const item of data.transaction.items) {
      line(`${item.description}`);
      line(`  ${Number(item.quantity)}x $${Number(item.unitPrice).toFixed(2)} = $${Number(item.totalPrice).toFixed(2)}`);
    }
    divider();
    line(`Sous-total:  $${data.transaction.subtotal.toFixed(2)}`);
    line(`TPS (5%):    $${data.transaction.tpsAmount.toFixed(2)}`);
    line(`TVQ (9.975%):$${data.transaction.tvqAmount.toFixed(2)}`);
    if (data.transaction.tipsAmount) line(`Pourboire:   $${data.transaction.tipsAmount.toFixed(2)}`);
    line(`TOTAL:       $${data.transaction.totalAmount.toFixed(2)}`);
    divider();
    line(data.mevMention);
    line('Merci! Thank you!');

    return lines.join('\n');
  }
}
