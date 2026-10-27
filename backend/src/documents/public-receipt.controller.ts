/**
 * Public electronic receipt (no login): GET /api/receipts/:token
 * The token is the transaction's unguessable receiptToken (144 bits) — the link printed / texted / shown as a
 * QR code by the POS. Returns the same receipt data as the authenticated route, plus the thermal text.
 */

import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ReceiptService } from './receipt.service';

@Controller('receipts')
export class PublicReceiptController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receipts: ReceiptService,
  ) {}

  @Get(':token')
  async get(@Param('token') token: string) {
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) throw new NotFoundException('Receipt not found');
    const tx = await this.prisma.transaction.findUnique({ where: { receiptToken: token }, select: { id: true } });
    if (!tx) throw new NotFoundException('Receipt not found');
    const data = await this.receipts.generateReceiptData(tx.id);
    return { ...data, text: await this.receipts.formatReceiptText(tx.id) };
  }
}
