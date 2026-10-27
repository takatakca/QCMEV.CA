/**
 * Partner Service
 *
 * Lets an outside POS (the TAKATAK MEV Clover app, Food Hub…) record its sales through this SEV:
 * the same createTransaction() path as our own UI — hash chain, signature, MEV-WEB submission,
 * offline queue — plus:
 *  - idempotency: (operator, source, externalRef) is unique; sending a record again returns it
 *  - devices and employees of the partner POS are mapped to ours by their external id and created
 *    on first use (an employee is registered with MEV-WEB — UTL — at that moment)
 *  - a public electronic receipt link (receiptToken) for every record
 */

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import {
  AuditEventType,
  DeviceType,
  LogSeverity,
  Prisma,
  Transaction,
  TransactionType,
  UserRole,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TransactionsService } from '../transactions/transactions.service';
import { ReceiptService } from '../documents/receipt.service';
import { AuthService } from '../auth/auth.service';
import { AuditLogService } from '../logging/audit-log.service';
import { PartnerContext } from './api-key.guard';
import { PartnerDeviceDto, PartnerEmployeeDto, PartnerRefundDto, PartnerSaleDto, PartnerVoidDto } from './dto/partner.dto';
import { generateApiKey } from './api-key.util';

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

export interface PartnerRecord {
  id:                   string;
  source:               string | null;
  externalRef:          string | null;
  transactionType:      TransactionType;
  status:               string;
  mevStatus:            string;
  mevTransactionNumber: string | null;
  civilDate:            string;
  transactionNumber:    number;
  subtotal:             number;
  tpsAmount:            number;
  tvqAmount:            number;
  totalAmount:          number;
  relatedTransactionId: string | null;
  isTraining:           boolean;
  receipt:              { token: string | null; url: string | null; text?: string; qrCodeImage?: string | null };
}

@Injectable()
export class PartnerService {
  private readonly logger = new Logger(PartnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly transactions: TransactionsService,
    private readonly receipts: ReceiptService,
    private readonly auth: AuthService,
    private readonly auditLog: AuditLogService,
  ) {}

  // ─── Sales ────────────────────────────────────────────────────────────────

  /** Record a sale. Returns { created: false } with the existing record when externalRef was already sent. */
  async createSale(partner: PartnerContext, dto: PartnerSaleDto): Promise<{ created: boolean; record: PartnerRecord }> {
    const existing = await this.findByRef(partner.operatorId, dto.source, dto.externalRef);
    if (existing) return { created: false, record: await this.toRecord(existing) };

    const device = await this.resolveDevice(partner.operatorId, dto.source, dto.device);
    const userId = await this.resolveUser(partner, dto.source, dto.employee);

    try {
      const tx = await this.transactions.createTransaction({
        operatorId:      partner.operatorId,
        deviceId:        device.id,
        userId,
        transactionType: dto.transactionType ?? TransactionType.ADDITION,
        items:           dto.lines,
        paymentMode:     dto.paymentMode,
        printMode:       dto.printMode,
        tableNumber:     dto.tableNumber,
        numberOfCovers:  dto.numberOfCovers,
        tipsAmount:      dto.tipsAmount,
        isTraining:      dto.isTraining,
        source:          dto.source,
        externalRef:     dto.externalRef,
      });
      return { created: true, record: await this.toRecord(tx) };
    } catch (err) {
      // Same externalRef sent twice at once: the second insert loses the unique race → answer with the first
      if (isUniqueViolation(err)) {
        const raced = await this.findByRef(partner.operatorId, dto.source, dto.externalRef);
        if (raced) return { created: false, record: await this.toRecord(raced) };
      }
      throw err;
    }
  }

  async getSale(partner: PartnerContext, source: string, externalRef: string, withReceipt = false): Promise<PartnerRecord> {
    const tx = await this.findByRef(partner.operatorId, source, externalRef);
    if (!tx) throw new NotFoundException(`No record ${source}/${externalRef}`);
    return this.toRecord(tx, withReceipt);
  }

  /** Cancel a whole sale (ANN). Idempotent on the cancellation's own externalRef. */
  async voidSale(partner: PartnerContext, source: string, saleRef: string, dto: PartnerVoidDto) {
    const sale = await this.findByRef(partner.operatorId, source, saleRef);
    if (!sale) throw new NotFoundException(`No record ${source}/${saleRef}`);

    const voidRef = dto.externalRef ?? `${saleRef}:void`;
    const existing = await this.findByRef(partner.operatorId, source, voidRef);
    if (existing) return { created: false, record: await this.toRecord(existing) };

    const userId = await this.resolveUser(partner, source, dto.employee);
    const cancellation = await this.transactions.cancelTransaction(
      partner.operatorId, sale.id, userId, dto.reason ?? 'Annulée dans le point de vente', { source, externalRef: voidRef },
    );
    return { created: true, record: await this.toRecord(cancellation) };
  }

  /** Refund some or all of a sale as a credit note (NDC). Idempotent on the refund's externalRef. */
  async refundSale(partner: PartnerContext, source: string, saleRef: string, dto: PartnerRefundDto) {
    const sale = await this.findByRef(partner.operatorId, source, saleRef);
    if (!sale) throw new NotFoundException(`No record ${source}/${saleRef}`);

    const existing = await this.findByRef(partner.operatorId, source, dto.externalRef);
    if (existing) return { created: false, record: await this.toRecord(existing) };

    if (sale.status === 'CANCELLED') throw new BadRequestException('Sale was cancelled — nothing left to refund');

    // Never refund more than was sold (before tax: refunds carry their own tax per line)
    const refundedSoFar = await this.prisma.transaction.aggregate({
      where: { operatorId: partner.operatorId, relatedTransactionId: sale.id, transactionType: TransactionType.CREDIT_NOTE },
      _sum: { subtotal: true },
    });
    const already = -Number(refundedSoFar._sum.subtotal ?? 0);
    const asked = dto.lines.reduce((s, l) => s + l.quantity * Math.abs(l.unitPrice), 0);
    if (already + asked > Number(sale.subtotal) + 0.005) {
      throw new BadRequestException(
        `Refund ${asked.toFixed(2)} + already refunded ${already.toFixed(2)} exceeds the sale subtotal ${Number(sale.subtotal).toFixed(2)}`,
      );
    }

    const userId = await this.resolveUser(partner, source, dto.employee);
    const tx = await this.transactions.createTransaction({
      operatorId:           partner.operatorId,
      deviceId:             sale.deviceId,
      userId,
      transactionType:      TransactionType.CREDIT_NOTE,
      items:                dto.lines.map(l => ({ ...l, unitPrice: -Math.abs(l.unitPrice) })),
      paymentMode:          dto.paymentMode ?? sale.paymentMode,
      relatedTransactionId: sale.id,
      isTraining:           sale.isTraining,
      source,
      externalRef:          dto.externalRef,
    });
    return { created: true, record: await this.toRecord(tx) };
  }

  /** What a partner shows its merchant: is this SEV ready to record sales? */
  async status(partner: PartnerContext) {
    const operator = await this.prisma.operator.findUnique({ where: { id: partner.operatorId } });
    if (!operator) throw new NotFoundException('Operator not found');
    const [cert, devices, usersWithoutMev, pending] = await Promise.all([
      this.prisma.certificate.findFirst({
        where: { operatorId: partner.operatorId, isActive: true, revokedAt: null },
        orderBy: { validTo: 'desc' },
        select: { validTo: true },
      }),
      this.prisma.device.findMany({
        where: { operatorId: partner.operatorId },
        select: { id: true, name: true, externalId: true, offlineMode: true, offlineSince: true, lastSyncAt: true, isActive: true },
      }),
      this.prisma.sEVUser.count({ where: { operatorId: partner.operatorId, isActive: true, mevUserId: null } }),
      this.prisma.offlineQueue.count({ where: { device: { operatorId: partner.operatorId }, status: 'PENDING' } }),
    ]);
    const certificateValid = Boolean(cert?.validTo && cert.validTo > new Date());
    return {
      operator:         { name: operator.name, neq: operator.neq, sector: operator.sector, environment: operator.environment },
      authorizationCodeSet: Boolean(operator.authorizationCode),
      certificate:      { valid: certificateValid, validTo: cert?.validTo ?? null },
      devices,
      offlineQueue:     pending,
      usersWithoutMevId: usersWithoutMev,
      ready:            certificateValid,
    };
  }

  // ─── API keys (JWT, operator admins) ──────────────────────────────────────

  async createKey(operatorId: string, actorId: string, label: string, userId?: string) {
    const signer = await this.prisma.sEVUser.findFirst({ where: { id: userId ?? actorId, operatorId, isActive: true } });
    if (!signer) throw new NotFoundException('User not found');
    const { key, prefix, keyHash } = generateApiKey();
    const row = await this.prisma.apiKey.create({ data: { operatorId, userId: signer.id, label, prefix, keyHash } });
    await this.auditLog.log({
      operatorId,
      eventType:   AuditEventType.API_KEY_CREATED,
      severity:    LogSeverity.INFO,
      userId:      actorId,
      entityId:    row.id,
      entityType:  'ApiKey',
      description: `Clé API partenaire « ${label} » créée (${prefix}…)`,
    });
    // The key itself is returned once, never stored
    return { id: row.id, label, prefix, userId: signer.id, createdAt: row.createdAt, key };
  }

  listKeys(operatorId: string) {
    return this.prisma.apiKey.findMany({
      where: { operatorId },
      select: { id: true, label: true, prefix: true, userId: true, lastUsedAt: true, revokedAt: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revokeKey(operatorId: string, actorId: string, id: string) {
    const row = await this.prisma.apiKey.findFirst({ where: { id, operatorId } });
    if (!row) throw new NotFoundException('API key not found');
    if (row.revokedAt) return { id, revokedAt: row.revokedAt };
    const updated = await this.prisma.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await this.auditLog.log({
      operatorId,
      eventType:   AuditEventType.API_KEY_REVOKED,
      severity:    LogSeverity.WARNING,
      userId:      actorId,
      entityId:    id,
      entityType:  'ApiKey',
      description: `Clé API partenaire « ${row.label} » révoquée (${row.prefix}…)`,
    });
    return { id, revokedAt: updated.revokedAt };
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private findByRef(operatorId: string, source: string, externalRef: string) {
    return this.prisma.transaction.findUnique({
      where: { operatorId_source_externalRef: { operatorId, source, externalRef } },
    });
  }

  /** The partner device, created on first use (each POS terminal is its own SEV device with its own hash chain) */
  private async resolveDevice(operatorId: string, source: string, d: PartnerDeviceDto) {
    const found = await this.prisma.device.findUnique({ where: { operatorId_externalId: { operatorId, externalId: d.externalId } } });
    if (found) {
      if (!found.isActive) throw new BadRequestException(`Device ${d.externalId} is inactive`);
      return found;
    }
    try {
      return await this.prisma.device.create({
        data: {
          operatorId,
          externalId:   d.externalId,
          // serialNumber is unique across operators: a device moved to another business gets its own row
          serialNumber: `${source}:${d.externalId}:${operatorId.slice(0, 8)}`,
          deviceType:   d.deviceType ?? DeviceType.CASH_REGISTER,
          name:         d.name ?? `${source} ${d.externalId}`,
          model:        d.model,
          description:  `Créé par l'API partenaire (${source})`,
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const raced = await this.prisma.device.findUnique({ where: { operatorId_externalId: { operatorId, externalId: d.externalId } } });
        if (raced) return raced;
      }
      throw err;
    }
  }

  /**
   * The SEV user for a partner employee, created + registered with MEV-WEB (UTL) on first use.
   * When MEV-WEB cannot register a new employee yet (offline, refused), the sale is signed by the key's
   * user instead — a sale is never lost — and that is audited; syncMevUsers() registers the employee later.
   */
  private async resolveUser(partner: PartnerContext, source: string, e?: PartnerEmployeeDto): Promise<string> {
    if (!e) return partner.userId;

    let user = await this.prisma.sEVUser.findUnique({
      where: { operatorId_externalId: { operatorId: partner.operatorId, externalId: e.externalId } },
    });

    if (!user) {
      try {
        const created = await this.auth.createUser(partner.operatorId, {
          username:  `${source}.${partner.operatorId.slice(0, 8)}.${e.externalId}`.toLowerCase().slice(0, 50),
          // Partner employees never log in to our UI: unguessable password nobody knows
          password:  crypto.randomBytes(24).toString('base64url'),
          firstName: e.firstName,
          lastName:  e.lastName,
          role:      UserRole.CASHIER,
        });
        await this.prisma.sEVUser.update({ where: { id: created.id }, data: { externalId: e.externalId } });
      } catch (err) {
        if (!(err instanceof ConflictException)) throw err; // same employee created by a concurrent sale
      }
      user = await this.prisma.sEVUser.findFirst({
        where: {
          operatorId: partner.operatorId,
          OR: [
            { externalId: e.externalId },
            { username: `${source}.${partner.operatorId.slice(0, 8)}.${e.externalId}`.toLowerCase().slice(0, 50) },
          ],
        },
      });
      if (user && !user.externalId) {
        user = await this.prisma.sEVUser.update({ where: { id: user.id }, data: { externalId: e.externalId } });
      }
    }

    if (user?.isActive && user.mevUserId) return user.id;

    if (user?.isActive && !user.mevUserId) {
      const mevUserId = await this.auth.registerUserWithMev(user.id);
      if (mevUserId) return user.id;
    }

    this.logger.warn(`Employee ${source}/${e.externalId} not usable for MEV yet — sale signed by the API key's user`);
    await this.auditLog.log({
      operatorId:  partner.operatorId,
      eventType:   AuditEventType.MEV_SUBMISSION_FAILED,
      severity:    LogSeverity.WARNING,
      userId:      partner.userId,
      description: `Employé ${source}/${e.externalId} pas encore inscrit au MEV-WEB — vente signée par l'utilisateur de la clé API`,
    });
    return partner.userId;
  }

  private receiptUrl(token: string | null): string | null {
    if (!token) return null;
    const base = (process.env.PUBLIC_RECEIPT_BASE_URL ?? process.env.FRONTEND_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
    return `${base}/r/${token}`;
  }

  async toRecord(tx: Transaction, withReceipt = false): Promise<PartnerRecord> {
    const record: PartnerRecord = {
      id:                   tx.id,
      source:               tx.source,
      externalRef:          tx.externalRef,
      transactionType:      tx.transactionType,
      status:               tx.status,
      mevStatus:            tx.mevSubmissionStatus,
      mevTransactionNumber: tx.mevTransactionNumber,
      civilDate:            tx.civilDate,
      transactionNumber:    tx.transactionNumber,
      subtotal:             Number(tx.subtotal),
      tpsAmount:            Number(tx.tpsAmount),
      tvqAmount:            Number(tx.tvqAmount),
      totalAmount:          Number(tx.totalAmount),
      relatedTransactionId: tx.relatedTransactionId,
      isTraining:           tx.isTraining,
      receipt:              { token: tx.receiptToken, url: this.receiptUrl(tx.receiptToken) },
    };
    if (withReceipt) {
      const data = await this.receipts.generateReceiptData(tx.id);
      record.receipt.text = await this.receipts.formatReceiptText(tx.id);
      record.receipt.qrCodeImage = data.qrCodeImage;
    }
    return record;
  }
}
