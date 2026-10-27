/**
 * Transactions Service
 *
 * Core business logic for MEV-compliant transaction processing.
 * Handles: creation, signing, MEV submission, offline queuing,
 * post-invoice modifications (mandatory per SW-76 §4.6),
 * cancellations, corrections, and daily summaries.
 */

import { Injectable, Logger, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MevWebService } from '../mev-web/mev-web.service';
import { AuditLogService } from '../logging/audit-log.service';
import { CertificatesService } from '../certificates/certificates.service';
import { OfflineQueueService } from '../offline/offline-queue.service';
import {
  TransactionRequestPayload,
  TransactionTypeCode,
  PaymentModeCode,
  PrintModeCode,
  SectorCode,
  FournitureItem,
  TaxCode,
  isTransientMevError,
  MevRequestTypeCode,
} from '../mev-web/dto/mev-web.dto';
import { quebecCivilDate } from '../mev-web/mev-time';
import {
  TransactionType,
  TransactionStatus,
  MevStatus,
  PaymentMode,
  PrintMode,
  ModificationType,
  AuditEventType,
  LogSeverity,
  MevRequestType,
} from '@prisma/client';

// Canadian tax rates (2025)
const TPS_RATE = 0.05;     // Federal GST
const TVQ_RATE = 0.09975;  // Québec QST

// Mapping our DB enums → MEV-WEB type codes
const TRX_TYPE_MAP: Record<TransactionType, TransactionTypeCode> = {
  ADDITION:        TransactionTypeCode.ADD,
  CLOSING_RECEIPT: TransactionTypeCode.RFC,
  CREDIT_NOTE:     TransactionTypeCode.NDC,
  ESTIMATION:      TransactionTypeCode.EST,
  QUOTE:           TransactionTypeCode.SOU,
  DUPLICATE:       TransactionTypeCode.DUP,
  REPRODUCTION:    TransactionTypeCode.REP,
  CANCELLATION:    TransactionTypeCode.ANN,
  CORRECTION:      TransactionTypeCode.COR,
  TRAINING:        TransactionTypeCode.FOR,
};

const PAYMENT_MAP: Record<PaymentMode, PaymentModeCode> = {
  CASH:        PaymentModeCode.ARC,
  CREDIT_CARD: PaymentModeCode.CRC,
  DEBIT_CARD:  PaymentModeCode.CRD,
  CHEQUE:      PaymentModeCode.CHQ,
  GIFT_CARD:   PaymentModeCode.CAD,
  MIXED:       PaymentModeCode.CMP,
  OTHER:       PaymentModeCode.AUT,
};

const PRINT_MAP: Record<PrintMode, PrintModeCode> = {
  PAPER:       PrintModeCode.PAP,
  ELECTRONIC:  PrintModeCode.ELC,
  NO_PRINT:    PrintModeCode.AUC,
};

export interface CreateTransactionDto {
  operatorId:    string;
  deviceId:      string;
  userId:        string;
  transactionType: TransactionType;
  items: Array<{
    description: string;
    quantity:    number;
    unitPrice:   number;
    taxCode?:    string;
  }>;
  paymentMode:   PaymentMode;
  printMode?:    PrintMode;
  tableNumber?:  string;
  numberOfCovers?: number;
  tipsAmount?:   number;
  relatedTransactionId?: string;
  isTraining?:   boolean;
  /** Partner POS that sent the sale (partner API) + its id for it — idempotency key */
  source?:       string;
  externalRef?:  string;
}

/** Money is rounded to the cent, half away from zero */
const round2 = (n: number) => Math.sign(n) * Math.round(Math.abs(n) * 100 + Number.EPSILON) / 100;

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mevWebService: MevWebService,
    private readonly auditLogService: AuditLogService,
    private readonly certificatesService: CertificatesService,
    private readonly offlineQueueService: OfflineQueueService,
  ) {}

  // ─── Create Transaction ───────────────────────────────────────────────────

  async createTransaction(dto: CreateTransactionDto) {
    const operator = await this.prisma.operator.findUnique({ where: { id: dto.operatorId } });
    if (!operator) throw new NotFoundException('Operator not found');

    // Tenant isolation: the device and the user must belong to the caller's operator
    const device = await this.prisma.device.findFirst({ where: { id: dto.deviceId, operatorId: dto.operatorId } });
    if (!device) throw new NotFoundException('Device not found');
    if (!device.isActive) throw new BadRequestException('Device is inactive');

    const user = await this.prisma.sEVUser.findFirst({ where: { id: dto.userId, operatorId: dto.operatorId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.mevUserId) throw new BadRequestException('User not registered with MEV-WEB');

    // ANN / COR / NDC must reference the ORIGINAL's MEV transaction number —
    // not our internal UUID. The original must belong to the same operator.
    let originalMevNumber: string | undefined;
    if (dto.relatedTransactionId) {
      const original = await this.prisma.transaction.findFirst({
        where: { id: dto.relatedTransactionId, operatorId: dto.operatorId },
        select: { mevTransactionNumber: true, mevSubmissionStatus: true },
      });
      if (!original) throw new NotFoundException('Related transaction not found');
      originalMevNumber = original.mevTransactionNumber ?? undefined;

      if (!originalMevNumber) {
        if (original.mevSubmissionStatus === MevStatus.REJECTED) {
          throw new BadRequestException('Related transaction was rejected by MEV-WEB — nothing to reference');
        }
        // Original still waiting for its MEV number (queued offline). On an offline
        // device the new record is queued too, behind the original, and the number
        // is filled in at flush time (MevWebService.submitOfflineBatch). A live
        // submission would send no numeroTransactionOriginal → refuse it for now.
        if (!device.offlineMode) {
          throw new ConflictException(
            'Related transaction is not certified by MEV-WEB yet (queued offline) — retry once it is',
          );
        }
      }
    }

    const civilDate = this.getCivilDate();

    // Calculate sequential transaction number for this device+day
    const maxNum = await this.prisma.transaction.aggregate({
      where: { deviceId: dto.deviceId, civilDate },
      _max: { transactionNumber: true },
    });
    const transactionNumber = (maxNum._max.transactionNumber ?? 0) + 1;

    // Tax per item (shown on the item lines), then on the taxable subtotals for the totals, all to the cent:
    // summing rounded line taxes can drift a cent from the tax of the whole bill.
    const items = dto.items.map(item => {
      const totalPrice = round2(item.quantity * item.unitPrice);
      const tpsAmount  = item.taxCode?.includes('F') ? round2(totalPrice * TPS_RATE) : 0;
      const tvqAmount  = item.taxCode?.includes('P') ? round2(totalPrice * TVQ_RATE) : 0;
      return { ...item, totalPrice, tpsAmount, tvqAmount };
    });

    const subtotal      = round2(items.reduce((s, i) => s + i.totalPrice, 0));
    const tpsAmount     = round2(items.filter(i => i.taxCode?.includes('F')).reduce((s, i) => s + i.totalPrice, 0) * TPS_RATE);
    const tvqAmount     = round2(items.filter(i => i.taxCode?.includes('P')).reduce((s, i) => s + i.totalPrice, 0) * TVQ_RATE);
    // montantTotal = the bill after tax. The tip is its own field (montantPourboire), never in the total;
    // a discount is a negative line, so tax applies to the discounted price.
    const totalAmount   = round2(subtotal + tpsAmount + tvqAmount);

    // Build and hash the transaction data
    const txDataStr = JSON.stringify({ deviceId: dto.deviceId, civilDate, transactionNumber, totalAmount });
    const previousHash = await this.mevWebService.getPreviousTransactionHash(dto.deviceId, civilDate, transactionNumber);
    const hashChain = this.mevWebService.generateHashChain(previousHash, txDataStr);

    // Persist to DB
    const transaction = await this.prisma.transaction.create({
      data: {
        operatorId:      dto.operatorId,
        deviceId:        dto.deviceId,
        userId:          dto.userId,
        transactionNumber,
        civilDate,
        transactionType: dto.transactionType,
        status:          TransactionStatus.DRAFT,
        subtotal,
        tpsAmount,
        tvqAmount,
        totalAmount,
        tipsAmount:      dto.tipsAmount,
        paymentMode:     dto.paymentMode,
        printMode:       dto.printMode ?? PrintMode.PAPER,
        tableNumber:     dto.tableNumber,
        numberOfCovers:  dto.numberOfCovers,
        hashChain,
        mevSubmissionStatus: device.offlineMode ? MevStatus.QUEUED_OFFLINE : MevStatus.PENDING,
        relatedTransactionId: dto.relatedTransactionId,
        isTraining:      dto.isTraining ?? false,
        source:          dto.source,
        externalRef:     dto.externalRef,
        receiptToken:    crypto.randomBytes(18).toString('base64url'),
        items: {
          create: items.map((item, idx) => ({
            description: item.description,
            quantity:    item.quantity,
            unitPrice:   item.unitPrice,
            totalPrice:  item.totalPrice,
            taxCode:     item.taxCode ?? null,
            tpsAmount:   item.tpsAmount,
            tvqAmount:   item.tvqAmount,
            sortOrder:   idx,
          })),
        },
      },
      include: { items: true },
    });

    // If offline, enqueue for later submission (linked to the transaction so the
    // MEV number / QR code are written back when the queue is flushed)
    if (device.offlineMode) {
      const payload = this.buildTransactionPayload(transaction, operator, user, items, originalMevNumber);
      await this.offlineQueueService.enqueue(dto.deviceId, MevRequestType.TRX, payload, transaction.id);
      this.logger.log(`Transaction ${transaction.id} queued offline`);
      return transaction;
    }

    // Submit to MEV-WEB
    try {
      const payload = this.buildTransactionPayload(transaction, operator, user, items, originalMevNumber);
      const response = await this.mevWebService.submitTransaction(dto.operatorId, payload);

      const updated = await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          mevTransactionNumber: response.numeroTransactionMEV,
          mevSubmissionStatus:  MevStatus.ACCEPTED,
          mevSubmittedAt:       new Date(),
          mevResponse:          response as object,
          qrCodeUrl:            response.urlCodeQR,
          certifiedData:        response.donneeCertifiee,
          status:               TransactionStatus.INVOICED,
          invoicedAt:           new Date(),
        },
      });

      await this.auditLogService.log({
        operatorId: dto.operatorId,
        eventType:  AuditEventType.TRANSACTION_CREATED,
        severity:   LogSeverity.INFO,
        userId:     dto.userId,
        deviceId:   dto.deviceId,
        entityId:   transaction.id,
        entityType: 'Transaction',
        description: `Transaction ${transactionNumber} (${dto.transactionType}) soumise au MEV-WEB`,
      });

      return updated;
    } catch (err) {
      // MEV-WEB unreachable (network / timeout / 5xx) → SW-76 §4.7 offline mode:
      // the sale is NOT lost — queue it, flag the device offline, return the transaction.
      if (isTransientMevError(err)) {
        const payload = this.buildTransactionPayload(transaction, operator, user, items, originalMevNumber);
        await this.offlineQueueService.enqueue(dto.deviceId, MevRequestType.TRX, payload, transaction.id);
        await this.offlineQueueService.activateOfflineMode(
          dto.deviceId,
          err instanceof Error ? err.message : String(err),
        );
        this.logger.warn(`Transaction ${transaction.id} queued offline — MEV-WEB unreachable`);
        return this.prisma.transaction.update({
          where: { id: transaction.id },
          data: { mevSubmissionStatus: MevStatus.QUEUED_OFFLINE },
          include: { items: true },
        });
      }

      // Business rejection or invalid payload — surface it to the caller
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { mevSubmissionStatus: MevStatus.REJECTED, mevResponse: { error: String(err) } },
      });
      throw err;
    }
  }

  // ─── Cancel Transaction ───────────────────────────────────────────────────

  async cancelTransaction(
    operatorId: string,
    transactionId: string,
    userId: string,
    reason: string,
    partner: { source?: string; externalRef?: string } = {},
  ) {
    const original = await this.prisma.transaction.findFirst({
      where: { id: transactionId, operatorId },
      include: { items: true },
    });
    if (!original) throw new NotFoundException('Transaction not found');
    if (original.status === TransactionStatus.CANCELLED) throw new BadRequestException('Already cancelled');
    if (original.transactionType === TransactionType.CANCELLATION) {
      throw new BadRequestException('A cancellation cannot itself be cancelled');
    }

    const cancellation = await this.createTransaction({
      operatorId:           original.operatorId,
      deviceId:             original.deviceId,
      userId,
      transactionType:      TransactionType.CANCELLATION,
      items:                original.items.map(i => ({
        description: i.description,
        quantity:    Number(i.quantity),
        unitPrice:   -Number(i.unitPrice),
        taxCode:     i.taxCode ?? undefined,
      })),
      paymentMode:          original.paymentMode,
      relatedTransactionId: transactionId,
      isTraining:           original.isTraining,
      source:               partner.source,
      externalRef:          partner.externalRef,
    });

    await this.prisma.transaction.update({
      where: { id: transactionId },
      data:  { status: TransactionStatus.CANCELLED },
    });

    await this.auditLogService.log({
      operatorId: original.operatorId,
      eventType:  AuditEventType.TRANSACTION_CANCELLED,
      severity:   LogSeverity.WARNING,
      userId,
      entityId:   transactionId,
      entityType: 'Transaction',
      description: `Transaction annulée: ${reason}`,
    });

    return cancellation;
  }

  // ─── Post-Invoice Modifications (SW-76 §4.6 — MANDATORY) ─────────────────

  /**
   * ANY modification after invoice issuance MUST create a TransactionModification record.
   * Failure to log these modifications is a compliance violation.
   */
  async addItemAfterInvoice(operatorId: string, transactionId: string, userId: string, item: { description: string; quantity: number; unitPrice: number; taxCode?: string }, reason: string) {
    await this.ensureInvoiced(operatorId, transactionId);
    await this.createModificationLog(transactionId, userId, ModificationType.ADD_ITEM, null, item, reason);
    return this.auditPostInvoiceAction(transactionId, userId, 'Ajout d\'un item après facturation');
  }

  async removeItemAfterInvoice(operatorId: string, transactionId: string, userId: string, itemId: string, reason: string = 'Non spécifié') {
    await this.ensureInvoiced(operatorId, transactionId);
    const item = await this.prisma.transactionItem.findFirst({ where: { id: itemId, transactionId } });
    if (!item) throw new NotFoundException('Item not found');
    await this.createModificationLog(transactionId, userId, ModificationType.REMOVE_ITEM, item, null, reason);
    return this.auditPostInvoiceAction(transactionId, userId, `Suppression de l'item "${item.description}" après facturation`);
  }

  async modifyPriceAfterInvoice(operatorId: string, transactionId: string, userId: string, itemId: string, newPrice: number, reason: string = 'Non spécifié') {
    await this.ensureInvoiced(operatorId, transactionId);
    const item = await this.prisma.transactionItem.findFirst({ where: { id: itemId, transactionId } });
    if (!item) throw new NotFoundException('Item not found');
    const oldPrice = item.unitPrice;
    await this.prisma.transactionItem.update({ where: { id: itemId }, data: { unitPrice: newPrice } });
    await this.createModificationLog(transactionId, userId, ModificationType.MODIFY_PRICE, { unitPrice: oldPrice }, { unitPrice: newPrice }, reason);
    return this.auditPostInvoiceAction(transactionId, userId, `Prix modifié: ${oldPrice} → ${newPrice} (${reason})`);
  }

  // ─── Daily Summary ────────────────────────────────────────────────────────

  async getDailySummary(operatorId: string, civilDateInput?: string) {
    const civilDate = civilDateInput ?? this.getCivilDate();
    const transactions = await this.prisma.transaction.findMany({
      where: { operatorId, civilDate, status: { not: TransactionStatus.CANCELLED } },
    });

    return {
      civilDate,
      totalSales:       transactions.filter(t => t.transactionType === 'ADDITION').reduce((s, t) => s + Number(t.totalAmount), 0),
      totalTps:         transactions.reduce((s, t) => s + Number(t.tpsAmount), 0),
      totalTvq:         transactions.reduce((s, t) => s + Number(t.tvqAmount), 0),
      totalCreditNotes: transactions.filter(t => t.transactionType === 'CREDIT_NOTE').reduce((s, t) => s + Number(t.totalAmount), 0),
      transactionCount: transactions.length,
    };
  }

  // ─── Private Helpers ──────────────────────────────────────────────────────

  private buildTransactionPayload(
    transaction: any,
    operator: any,
    user: any,
    items: any[],
    originalMevNumber?: string,
  ): TransactionRequestPayload {
    return {
      entete: this.mevWebService.buildHeader(operator, MevRequestTypeCode.TRX, {
        typeAppareil:   'CAISSEENREGISTREUSE',
        numeroAppareil: transaction.deviceId,
        dateCivile:     transaction.civilDate,
      }),
      corps: {
        neq:             operator.neq,
        codeAutorisation: operator.authorizationCode ?? '',
        secteur:         operator.sector as SectorCode,
        transaction: {
          numeroTransaction:      transaction.transactionNumber,
          typeTransaction:        TRX_TYPE_MAP[transaction.transactionType as TransactionType],
          montantSousTotal:       Number(transaction.subtotal),
          montantTPS:             Number(transaction.tpsAmount),
          montantTVQ:             Number(transaction.tvqAmount),
          montantTotal:           Number(transaction.totalAmount),
          montantPourboire:       transaction.tipsAmount ? Number(transaction.tipsAmount) : undefined,
          modePaiement:           PAYMENT_MAP[transaction.paymentMode as PaymentMode],
          modeImpression:         PRINT_MAP[transaction.printMode as PrintMode],
          numeroTable:            transaction.tableNumber,
          nombreCouverts:         transaction.numberOfCovers,
          hashChaine:             transaction.hashChain,
          identifiantUtilisateur: user.mevUserId,
          fournitures:            items.map(item => ({
            description:  item.description,
            quantite:     Number(item.quantity),
            prixUnitaire: Number(item.unitPrice),
            montantTotal: Number(item.totalPrice),
            codeTaxe:     (item.taxCode as TaxCode) ?? '',
            montantTPS:   Number(item.tpsAmount),
            montantTVQ:   Number(item.tvqAmount),
          })),
          numeroTransactionOriginal: originalMevNumber,
        },
      },
    };
  }

  /** Québec local civil date — NOT UTC (see mev-time.ts) */
  private getCivilDate(): string {
    return quebecCivilDate();
  }

  /** Tenant isolation: 404 unless the transaction belongs to this operator */
  async assertOwned(operatorId: string, transactionId: string) {
    const tx = await this.prisma.transaction.findFirst({ where: { id: transactionId, operatorId }, select: { id: true } });
    if (!tx) throw new NotFoundException('Transaction not found');
  }

  private async ensureInvoiced(operatorId: string, transactionId: string) {
    const tx = await this.prisma.transaction.findFirst({ where: { id: transactionId, operatorId } });
    if (!tx) throw new NotFoundException('Transaction not found');
    if (tx.status !== TransactionStatus.INVOICED) throw new BadRequestException('Transaction is not invoiced');
  }

  private async createModificationLog(
    transactionId: string,
    userId: string,
    type: ModificationType,
    previousValue: unknown,
    newValue: unknown,
    reason: string,
  ) {
    return this.prisma.transactionModification.create({
      data: {
        transactionId,
        modificationType: type,
        description: `${type}: ${reason}`,
        previousValue: previousValue as object,
        newValue: newValue as object,
        performedByUserId: userId,
        reason,
      },
    });
  }

  private async auditPostInvoiceAction(transactionId: string, userId: string, description: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    await this.auditLogService.log({
      operatorId: tx?.operatorId,
      eventType:  AuditEventType.TRANSACTION_MODIFIED,
      severity:   LogSeverity.WARNING,
      userId,
      entityId:   transactionId,
      entityType: 'Transaction',
      description,
    });
    return tx;
  }

  /** Returns the French "mention" text to print on receipts per SW-76 */
  getDocumentMention(type: TransactionType): string {
    const mentions: Record<TransactionType, string> = {
      ADDITION:        'REÇU',
      CLOSING_RECEIPT: 'FERMETURE DE COMPTE',
      CREDIT_NOTE:     'NOTE DE CRÉDIT',
      ESTIMATION:      'ESTIMATION',
      QUOTE:           'SOUMISSION',
      DUPLICATE:       'DUPLICATA',
      REPRODUCTION:    'REPRODUCTION',
      CANCELLATION:    'ANNULATION',
      CORRECTION:      'CORRECTION',
      TRAINING:        'FORMATION (Sans valeur légale)',
    };
    return mentions[type] ?? 'DOCUMENT';
  }
}
