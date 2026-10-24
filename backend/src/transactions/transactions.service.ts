/**
 * Transactions Service
 *
 * Core business logic for MEV-compliant transaction processing.
 * Handles: creation, signing, MEV submission, offline queuing,
 * post-invoice modifications (mandatory per SW-76 §4.6),
 * cancellations, corrections, and daily summaries.
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { MevWebService } from '../mev-web/mev-web.service';
import { AuditLogService } from '../logging/audit-log.service';
import { CertificatesService } from '../certificates/certificates.service';
import {
  TransactionRequestPayload,
  TransactionTypeCode,
  PaymentModeCode,
  PrintModeCode,
  SectorCode,
  FournitureItem,
  TaxCode,
} from '../mev-web/dto/mev-web.dto';
import {
  TransactionType,
  TransactionStatus,
  MevStatus,
  PaymentMode,
  PrintMode,
  ModificationType,
  AuditEventType,
  LogSeverity,
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
  discountAmount?: number;
  relatedTransactionId?: string;
  isTraining?:   boolean;
}

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mevWebService: MevWebService,
    private readonly auditLogService: AuditLogService,
    private readonly certificatesService: CertificatesService,
  ) {}

  // ─── Create Transaction ───────────────────────────────────────────────────

  async createTransaction(dto: CreateTransactionDto) {
    const operator = await this.prisma.operator.findUnique({ where: { id: dto.operatorId } });
    if (!operator) throw new NotFoundException('Operator not found');

    const device = await this.prisma.device.findUnique({ where: { id: dto.deviceId } });
    if (!device) throw new NotFoundException('Device not found');

    const user = await this.prisma.sEVUser.findUnique({ where: { id: dto.userId } });
    if (!user) throw new NotFoundException('User not found');
    if (!user.mevUserId) throw new BadRequestException('User not registered with MEV-WEB');

    const civilDate = this.getCivilDate();

    // Calculate sequential transaction number for this device+day
    const maxNum = await this.prisma.transaction.aggregate({
      where: { deviceId: dto.deviceId, civilDate },
      _max: { transactionNumber: true },
    });
    const transactionNumber = (maxNum._max.transactionNumber ?? 0) + 1;

    // Calculate tax amounts per item
    const items = dto.items.map(item => {
      const totalPrice = item.quantity * item.unitPrice;
      const tpsAmount  = item.taxCode?.includes('F') ? totalPrice * TPS_RATE : 0;
      const tvqAmount  = item.taxCode?.includes('P') ? totalPrice * TVQ_RATE : 0;
      return { ...item, totalPrice, tpsAmount, tvqAmount };
    });

    const subtotal      = items.reduce((s, i) => s + i.totalPrice, 0);
    const tpsAmount     = items.reduce((s, i) => s + i.tpsAmount, 0);
    const tvqAmount     = items.reduce((s, i) => s + i.tvqAmount, 0);
    const totalAmount   = subtotal + tpsAmount + tvqAmount + (dto.tipsAmount ?? 0) - (dto.discountAmount ?? 0);

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
        discountAmount:  dto.discountAmount,
        paymentMode:     dto.paymentMode,
        printMode:       dto.printMode ?? PrintMode.PAPER,
        tableNumber:     dto.tableNumber,
        numberOfCovers:  dto.numberOfCovers,
        hashChain,
        mevSubmissionStatus: device.offlineMode ? MevStatus.QUEUED_OFFLINE : MevStatus.PENDING,
        relatedTransactionId: dto.relatedTransactionId,
        isTraining:      dto.isTraining ?? false,
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

    // If offline, enqueue for later submission
    if (device.offlineMode) {
      const payload = this.buildTransactionPayload(transaction, operator, user, items);
      await this.prisma.offlineQueue.create({
        data: { deviceId: dto.deviceId, requestType: 'TRX', payload: payload as object },
      });
      this.logger.log(`Transaction ${transaction.id} queued offline`);
      return transaction;
    }

    // Submit to MEV-WEB
    try {
      const payload = this.buildTransactionPayload(transaction, operator, user, items);
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
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { mevSubmissionStatus: MevStatus.REJECTED, mevResponse: { error: String(err) } },
      });
      throw err;
    }
  }

  // ─── Cancel Transaction ───────────────────────────────────────────────────

  async cancelTransaction(transactionId: string, userId: string, reason: string) {
    const original = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      include: { items: true },
    });
    if (!original) throw new NotFoundException('Transaction not found');
    if (original.status === TransactionStatus.CANCELLED) throw new BadRequestException('Already cancelled');

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
  async addItemAfterInvoice(transactionId: string, userId: string, item: { description: string; quantity: number; unitPrice: number; taxCode?: string }, reason: string) {
    await this.ensureInvoiced(transactionId);
    await this.createModificationLog(transactionId, userId, ModificationType.ADD_ITEM, null, item, reason);
    return this.auditPostInvoiceAction(transactionId, userId, 'Ajout d\'un item après facturation');
  }

  async removeItemAfterInvoice(transactionId: string, userId: string, itemId: string, reason: string) {
    await this.ensureInvoiced(transactionId);
    const item = await this.prisma.transactionItem.findUnique({ where: { id: itemId } });
    await this.createModificationLog(transactionId, userId, ModificationType.REMOVE_ITEM, item, null, reason);
    return this.auditPostInvoiceAction(transactionId, userId, 'Suppression d\'un item après facturation');
  }

  async modifyPriceAfterInvoice(transactionId: string, userId: string, itemId: string, newPrice: number, reason: string) {
    await this.ensureInvoiced(transactionId);
    const item = await this.prisma.transactionItem.findUnique({ where: { id: itemId } });
    await this.createModificationLog(transactionId, userId, ModificationType.MODIFY_PRICE, { unitPrice: item?.unitPrice }, { unitPrice: newPrice }, reason);
    return this.auditPostInvoiceAction(transactionId, userId, 'Modification de prix après facturation');
  }

  // ─── Daily Summary ────────────────────────────────────────────────────────

  async getDailySummary(operatorId: string, civilDate: string) {
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
  ): TransactionRequestPayload {
    const now = new Date();
    return {
      entete: {
        typeRequete:    'TRX' as any,
        codeSEV:        operator.sevCertificationCode ?? 'DEV-CODE',
        versionSEV:     operator.sevVersion,
        typeAppareil:   'CAISSEENREGISTREUSE',
        numeroAppareil: transaction.deviceId,
        dateCivile:     transaction.civilDate,
        heureDebut:     now.toTimeString().replace(/\D/g, '').slice(0, 6),
        signature:      '', // Will be filled by MevWebService.signAndPrepare()
      },
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
          tableNumber:            transaction.tableNumber,
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
          numeroTransactionOriginal: transaction.relatedTransactionId,
        },
      },
    };
  }

  private getCivilDate(): string {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }

  private async ensureInvoiced(transactionId: string) {
    const tx = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
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
