/**
 * Issuance of every SEV transaction (staff sales, Food Hub sales, credit notes, reprints, post-invoice changes).
 *
 *   1. checks (operator, device, user registered with UTL, sale rules);
 *   2. in ONE database transaction, with the device row locked: number (per device per civil day, America/Montreal),
 *      signature chain (signa.preced = previous signature, 88 "=" for the first one), ECDSA signature, internal
 *      SHA-256 audit chain, the Transaction row, an offline-queue entry, and the caller's own rows (idempotency);
 *   3. after commit: send to MEV-WEB together with any transaction still waiting on that device (transLot).
 * A network failure never makes a transaction REJECTED: it stays signed and queued (offline mode, 48 h limit).
 * Changes after invoicing always create new, referenced transactions (credit note and/or new receipt).
 */
import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AuditEventType,
  DocumentKind,
  LogSeverity,
  MevStatus,
  ModificationType,
  Prisma,
  QueueStatus,
  Transaction,
  TransactionItem,
  TransactionStatus,
} from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { canonicalJson } from '../common/canonical-json';
import { lineTotal, mevAmount, TaxCode } from '../common/money';
import { safeErrorMessage } from '../common/redact';
import { civilTime } from '../common/time';
import { FIRST_PRECED, GENESIS_HASH, nextHashChain, signP256 } from '../crypto/ecdsa';
import { CertificatesService, DeviceNotReadyError } from '../certificates/certificates.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MevUnreachableError, MevWebService } from '../mev-web/mev-web.service';
import { classifyErrors, TransActu, TransCore } from '../mev-web/mev-web.types';
import { PrismaService } from '../prisma/prisma.service';
import { encryptQrPayload } from '../crypto/qr-crypto';
import { qrContent, qrPayload } from '../receipts/receipt-renderer';
import { assertSaleRules, buildTransCore, PaymentCode, SaleDraft, SaleLine, SaleRuleError, saleTotals, SaleTotals } from './trans-builder';

export type TxWithItems = Transaction & { items: TransactionItem[] };

export interface IssueRequest {
  operatorId: string;
  deviceId: string;
  userId: string;
  draft: SaleDraft;
  relatedTransactionId?: string | null;
  externalRef?: string | null;
  occurredAt?: Date | null;
  modification?: { type: ModificationType; originalId: string; reason?: string | null; previous?: unknown; next?: unknown };
  /** Runs inside the same database transaction once the Transaction row exists (e.g. the idempotency row). */
  inTx?: (tx: Prisma.TransactionClient, created: Transaction) => Promise<void>;
}

export interface IssueResult {
  transaction: TxWithItems;
  totals: SaleTotals;
  warnings: string[];
}

export class LocationNotReadyError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
  }
}

const KIND_TO_DB: Record<SaleDraft['documentKind'], DocumentKind> = {
  RECEIPT: DocumentKind.RECEIPT,
  CREDIT_NOTE: DocumentKind.CREDIT_NOTE,
  ADDITION: DocumentKind.ADDITION,
  ESTIMATE: DocumentKind.ESTIMATE,
  QUOTE: DocumentKind.QUOTE,
};

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger('Transactions');
  private readonly deviceLocks = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly certificates: CertificatesService,
    private readonly mevWeb: MevWebService,
    private readonly audit: AuditLogService,
  ) {}

  // ─── Issue ─────────────────────────────────────────────────────────────────

  async issue(req: IssueRequest): Promise<IssueResult> {
    const { operatorId, deviceId, userId, draft } = req;
    const [operator, device, user] = await Promise.all([
      this.prisma.operator.findUnique({ where: { id: operatorId } }),
      this.prisma.device.findFirst({ where: { id: deviceId, operatorId } }),
      this.prisma.sEVUser.findFirst({ where: { id: userId, operatorId } }),
    ]);
    if (!operator) throw new NotFoundException('Operator not found');
    if (!device || !device.isActive) throw new LocationNotReadyError('deviceReady', 'device not found or inactive');
    if (!device.fileNumber) throw new LocationNotReadyError('deviceReady', 'device has no mandatory-billing file number');
    if (operator.environment !== this.cfg.mevEnvironment) {
      throw new LocationNotReadyError('certReady', `operator is set up for ${operator.environment}, server runs ${this.cfg.mevEnvironment}`);
    }
    if (!user || !user.isActive || !user.mevUserName || !user.mevRegisteredAt) {
      throw new LocationNotReadyError('usersReady', 'user is not registered with MEV-WEB (UTL)');
    }
    const related = req.relatedTransactionId
      ? await this.prisma.transaction.findFirst({ where: { id: req.relatedTransactionId, operatorId } })
      : null;
    if (req.relatedTransactionId && !related) throw new NotFoundException('Referenced transaction not found');

    const totals = saleTotals(draft);
    assertSaleRules(draft, totals);
    const warnings: string[] = [];
    if (totals.taxGap) warnings.push('taxGap');

    let material;
    try {
      material = await this.certificates.signingMaterial(deviceId);
    } catch (e) {
      if (e instanceof DeviceNotReadyError) throw new LocationNotReadyError(e.field, e.message);
      throw e;
    }
    if (material.expired) warnings.push('certificateInvalid');
    // SW-76 §4.2.1: the QR link data is encrypted with MEV-WEB's certificate (returned by CRT). No certificate, no invoice.
    const mevWebCertPem = await this.certificates.mevWebCertificate(deviceId);
    if (!mevWebCertPem) throw new LocationNotReadyError('certReady', 'no MEV-WEB certificate to encrypt the QR code (run CRT again)');

    const created = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Device" WHERE id = ${deviceId} FOR UPDATE`;
        const dev = await tx.device.findUniqueOrThrow({ where: { id: deviceId } });
        const prev = dev.lastSeq > 0 ? await tx.transaction.findUnique({ where: { deviceId_deviceSeq: { deviceId, deviceSeq: dev.lastSeq } } }) : null;
        const now = civilTime(new Date());
        const max = await tx.transaction.aggregate({ where: { deviceId, civilDate: now.civilDate }, _max: { transactionNumber: true } });
        const number = (max._max.transactionNumber ?? 0) + 1;
        const noTrans = String(number); // SPEC: noTrans format (length, padding) per SW-73.
        const preced = prev?.signature ?? FIRST_PRECED;

        const { core, signedString } = buildTransCore(
          draft,
          {
            noTrans,
            datTrans: now.datTrans,
            utc: now.utc,
            datActu: now.datTrans,
            nomUtil: user.mevUserName as string,
            preced,
            ref: related ? { noTrans: related.noTrans, datTrans: related.datTrans, subtotalCents: related.subtotalCents } : undefined,
          },
          { noTPS: operator.noTPS, noTVQ: operator.noTVQ },
        );
        const signature = signP256(material.privateKey, signedString);
        const full: TransCore = { ...core, signa: { actu: signature, preced, datActu: now.datTrans } };
        const hashChain = nextHashChain(prev?.hashChain ?? GENESIS_HASH, canonicalJson(full));
        const qr = qrContent(this.cfg.qrBaseUrl, encryptQrPayload(mevWebCertPem, qrPayload({ idApprl: material.mevDeviceId, noTrans, datTrans: now.datTrans, apresTax: full.mont.apresTax, signature })));

        const row = await tx.transaction.create({
          data: {
            operatorId,
            deviceId,
            userId,
            transactionNumber: number,
            noTrans,
            civilDate: now.civilDate,
            datTrans: now.datTrans,
            utcOffset: now.utc,
            deviceSeq: dev.lastSeq + 1,
            transactionType: draft.typTrans,
            documentKind: KIND_TO_DB[draft.documentKind],
            transactionMode: draft.modTrans,
            printMode: draft.modImpr,
            printFormat: draft.formImpr,
            serviceType: draft.typServ ?? null,
            tableNumber: draft.noTabl ?? null,
            numberOfCovers: draft.nbClint ?? null,
            ecommerce: draft.ecommerce,
            paymentMode: draft.modPai,
            subtotalCents: totals.subtotalCents,
            tpsCents: totals.tpsCents,
            tvqCents: totals.tvqCents,
            totalCents: totals.totalCents,
            tipCents: draft.tipCents || null,
            signature,
            previousSignature: preced,
            signedAt: now.datTrans,
            hashChain,
            requestJson: full as unknown as Prisma.InputJsonValue,
            qrContent: qr,
            relatedTransactionId: related?.id ?? null,
            externalRef: req.externalRef ?? null,
            occurredAt: req.occurredAt ?? null,
            mevStatus: MevStatus.PENDING,
            items: {
              create: draft.lines.map((l, i) => ({
                ref: l.ref ?? null,
                description: l.description,
                quantity: l.quantity,
                unitPriceCents: l.unitPriceCents,
                totalCents: l.totalCents,
                tax: l.tax,
                activity: l.activity,
                isModifier: !!l.isModifier,
                sortOrder: i,
              })),
            },
          },
        });
        await tx.device.update({ where: { id: deviceId }, data: { lastSeq: dev.lastSeq + 1 } });
        await tx.offlineQueue.create({ data: { deviceId, transactionId: row.id, status: QueueStatus.PENDING } });
        if (req.modification) {
          await tx.transactionModification.create({
            data: {
              transactionId: req.modification.originalId,
              resultTransactionId: row.id,
              modificationType: req.modification.type,
              description: `${req.modification.type} → transaction ${noTrans}`,
              previousValue: (req.modification.previous ?? undefined) as Prisma.InputJsonValue | undefined,
              newValue: (req.modification.next ?? undefined) as Prisma.InputJsonValue | undefined,
              reason: req.modification.reason ?? null,
              performedByUserId: userId,
            },
          });
        }
        if (req.inTx) await req.inTx(tx, row);
        return row;
      },
      { timeout: 20000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    await this.audit.log({
      operatorId,
      eventType: AuditEventType.TRANSACTION_CREATED,
      userId,
      deviceId,
      entityId: created.id,
      entityType: 'Transaction',
      description: `transaction ${created.noTrans} (${draft.typTrans}/${draft.modImpr}${draft.documentKind === 'CREDIT_NOTE' ? ', credit note' : ''}) signed`,
    });

    await this.submitDevice(deviceId);
    const transaction = await this.prisma.transaction.findUniqueOrThrow({ where: { id: created.id }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    if (transaction.mevStatus === MevStatus.OFFLINE_PENDING) warnings.push('offline');
    return { transaction, totals, warnings };
  }

  // ─── Submission (online, offline, batch) ──────────────────────────────────

  /** Sends every waiting transaction of the device, in chain order, as one transActu or one transLot. */
  async submitDevice(deviceId: string): Promise<{ sent: number; accepted: number; offline: boolean }> {
    const previous = this.deviceLocks.get(deviceId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.submitDeviceNow(deviceId));
    this.deviceLocks.set(deviceId, run);
    try {
      return await run;
    } finally {
      if (this.deviceLocks.get(deviceId) === run) this.deviceLocks.delete(deviceId);
    }
  }

  private async submitDeviceNow(deviceId: string): Promise<{ sent: number; accepted: number; offline: boolean }> {
    const entries = await this.prisma.offlineQueue.findMany({
      where: { deviceId, status: QueueStatus.PENDING, transactionId: { not: null } },
      include: { transaction: true },
    });
    const pending = entries.filter((e) => e.transaction).sort((a, b) => a.transaction!.deviceSeq - b.transaction!.deviceSeq).slice(0, 100);
    if (!pending.length) return { sent: 0, accepted: 0, offline: false };

    const device = await this.prisma.device.findUniqueOrThrow({ where: { id: deviceId }, include: { operator: true } });
    const op = device.operator;
    const material = await this.certificates.signingMaterial(deviceId);
    const trans: TransActu[] = pending.map((e) => ({
      ...(e.transaction!.requestJson as unknown as TransCore),
      noDossFO: device.fileNumber as string,
      noTPS: op.noTPS,
      noTVQ: op.noTVQ,
    }));
    const now = new Date();
    await this.prisma.offlineQueue.updateMany({ where: { id: { in: pending.map((e) => e.id) } }, data: { lastAttemptAt: now, attempts: { increment: 1 } } });

    let results;
    try {
      results = await this.mevWeb.sendTransactions({ id: op.id, noTPS: op.noTPS, noTVQ: op.noTVQ }, material, trans);
    } catch (e) {
      if (!(e instanceof MevUnreachableError)) throw e;
      await this.prisma.transaction.updateMany({
        where: { id: { in: pending.map((p) => p.transactionId as string) }, mevStatus: MevStatus.PENDING },
        data: { mevStatus: MevStatus.OFFLINE_PENDING },
      });
      if (!device.offlineMode) {
        await this.prisma.device.update({ where: { id: deviceId }, data: { offlineMode: true, offlineSince: now } });
        await this.audit.log({ operatorId: op.id, eventType: AuditEventType.OFFLINE_MODE_ACTIVATED, severity: LogSeverity.WARNING, deviceId, description: 'MEV-WEB unreachable: offline mode (transactions signed locally, sent within 48 h)' });
      }
      await this.prisma.offlineQueue.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { errorMessage: e.message } });
      return { sent: pending.length, accepted: 0, offline: true };
    }

    let accepted = 0;
    for (const [i, entry] of pending.entries()) {
      const r = results[i] ?? {};
      const outcome = classifyErrors(r.listErr);
      const txId = entry.transactionId as string;
      if (outcome === 'accepted') {
        accepted++;
        await this.prisma.$transaction([
          this.prisma.transaction.update({
            where: { id: txId },
            data: {
              mevStatus: MevStatus.ACCEPTED,
              mevTransactionNumber: r.psiNoTrans ?? null,
              mevProcessedAt: r.psiDatTrans ?? null,
              mevSubmittedAt: now,
              mevResponse: r as unknown as Prisma.InputJsonValue,
              mevErrors: Prisma.DbNull,
            },
          }),
          this.prisma.offlineQueue.update({ where: { id: entry.id }, data: { status: QueueStatus.COMPLETED, processedAt: now, errorMessage: null } }),
        ]);
      } else if (outcome === 'retry_batch') {
        await this.prisma.transaction.update({ where: { id: txId }, data: { mevStatus: MevStatus.RETRY_BATCH, mevErrors: (r.listErr ?? []) as unknown as Prisma.InputJsonValue } });
      } else {
        await this.prisma.$transaction([
          this.prisma.transaction.update({ where: { id: txId }, data: { mevStatus: MevStatus.REJECTED, mevSubmittedAt: now, mevErrors: (r.listErr ?? []) as unknown as Prisma.InputJsonValue } }),
          this.prisma.offlineQueue.update({ where: { id: entry.id }, data: { status: QueueStatus.FAILED, processedAt: now, errorMessage: (r.listErr ?? []).map((x) => `${x.codRetour} ${x.id}`).join(', ').slice(0, 500) } }),
        ]);
        await this.audit.log({ operatorId: op.id, eventType: AuditEventType.MEV_ERROR, severity: LogSeverity.ERROR, deviceId, entityId: txId, entityType: 'Transaction', description: `transaction ${entry.transaction!.noTrans} rejected by MEV-WEB`, metadata: { errors: r.listErr ?? [] } });
      }
    }
    if (device.offlineMode) {
      await this.prisma.device.update({ where: { id: deviceId }, data: { offlineMode: false, offlineSince: null, lastSyncAt: now } });
      await this.audit.log({ operatorId: op.id, eventType: AuditEventType.OFFLINE_SYNC, deviceId, description: `back online: ${accepted}/${pending.length} queued transactions accepted` });
    } else {
      await this.prisma.device.update({ where: { id: deviceId }, data: { lastSyncAt: now } });
    }
    return { sent: pending.length, accepted, offline: false };
  }

  // ─── Credit notes, reprints, post-invoice changes ─────────────────────────

  async loadOwned(operatorId: string, id: string): Promise<TxWithItems> {
    const tx = await this.prisma.transaction.findFirst({ where: { id, operatorId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    if (!tx) throw new NotFoundException('Transaction not found');
    return tx;
  }

  /** Lines of an existing transaction as sale lines. */
  linesOf(tx: TxWithItems): SaleLine[] {
    return tx.items.map((i) => ({
      ref: i.ref ?? undefined,
      description: i.description,
      quantity: i.quantity,
      unitPriceCents: i.unitPriceCents,
      totalCents: i.totalCents,
      tax: i.tax as TaxCode,
      activity: i.activity,
      isModifier: i.isModifier,
    }));
  }

  /** Amount already credited on an original sale (negative or 0). */
  async creditedSoFar(originalId: string): Promise<number> {
    const agg = await this.prisma.transaction.aggregate({
      where: { relatedTransactionId: originalId, documentKind: DocumentKind.CREDIT_NOTE },
      _sum: { subtotalCents: true },
    });
    return agg._sum.subtotalCents ?? 0;
  }

  /**
   * Credit note (RFER, negative amounts, reference to the original). Full: every line and the taxes exactly as charged.
   * Partial: the given lines (positive values, negated here); taxes computed.
   */
  async creditNote(p: {
    operatorId: string;
    originalId: string;
    userId: string;
    deviceId?: string;
    full: boolean;
    lines?: SaleLine[];
    /** Partial credit only: the taxes refunded, as positive magnitudes (they are negated here). */
    taxMagnitudes?: { tpsCents: number; tvqCents: number };
    reason?: string | null;
    modPai?: PaymentCode;
    externalRef?: string | null;
    inTx?: IssueRequest['inTx'];
    modificationType?: ModificationType;
  }): Promise<IssueResult> {
    const original = await this.loadOwned(p.operatorId, p.originalId);
    if (original.documentKind === DocumentKind.CREDIT_NOTE) throw new BadRequestException('A credit note cannot be credited');
    if (original.printMode !== 'FAC') throw new BadRequestException('Credit the original transaction, not a reprint');
    const credited = await this.creditedSoFar(original.id);
    const remaining = original.subtotalCents + credited;
    let lines: SaleLine[];
    let taxOverride: SaleDraft['taxOverride'];
    if (p.full) {
      if (credited !== 0) throw new BadRequestException('This sale already has a credit note; credit the remaining lines instead');
      lines = this.linesOf(original).map((l) => ({ ...l, unitPriceCents: -l.unitPriceCents, totalCents: -l.totalCents }));
      taxOverride = { tpsCents: -original.tpsCents, tvqCents: -original.tvqCents };
    } else {
      if (!p.lines?.length) throw new BadRequestException('lines are required for a partial credit note');
      lines = p.lines.map((l) => ({ ...l, unitPriceCents: -Math.abs(l.unitPriceCents), totalCents: -Math.abs(l.totalCents) }));
      if (p.taxMagnitudes) taxOverride = { tpsCents: -Math.abs(p.taxMagnitudes.tpsCents), tvqCents: -Math.abs(p.taxMagnitudes.tvqCents) };
    }
    const sum = -lines.reduce((s, l) => s + l.totalCents, 0);
    if (sum > remaining) throw new SaleRuleError('lines', `credit (${mevAmount(sum)}) exceeds what remains on the sale (${mevAmount(remaining)})`);

    const result = await this.issue({
      operatorId: p.operatorId,
      deviceId: p.deviceId ?? original.deviceId,
      userId: p.userId,
      relatedTransactionId: original.id,
      externalRef: p.externalRef ?? original.externalRef,
      draft: {
        documentKind: 'CREDIT_NOTE',
        typTrans: 'RFER',
        modImpr: 'FAC',
        formImpr: original.printFormat,
        modTrans: original.transactionMode,
        typServ: original.serviceType ?? undefined,
        ecommerce: original.ecommerce,
        modPai: p.modPai ?? (original.paymentMode as PaymentCode),
        lines,
        taxOverride,
      },
      modification: { type: p.modificationType ?? ModificationType.CREDIT_NOTE, originalId: original.id, reason: p.reason ?? null, previous: { subtotalCents: original.subtotalCents }, next: { creditedCents: sum } },
      inTx: p.inTx,
    });
    const nowCredited = credited - sum;
    await this.prisma.transaction.update({
      where: { id: original.id },
      data: { status: -nowCredited >= original.subtotalCents ? TransactionStatus.CREDITED : TransactionStatus.PARTIALLY_CREDITED },
    });
    await this.audit.log({ operatorId: p.operatorId, eventType: AuditEventType.TRANSACTION_CREDITED, userId: p.userId, entityId: original.id, entityType: 'Transaction', description: `credit note ${result.transaction.noTrans} on transaction ${original.noTrans}${p.reason ? `: ${p.reason}` : ''}` });
    return result;
  }

  /** Reproduction (RPR, for the customer) or duplicate (DUP, merchant copy). Both are transmitted. */
  async reprint(p: { operatorId: string; originalId: string; userId: string; mode: 'RPR' | 'DUP'; inTx?: IssueRequest['inTx'] }): Promise<IssueResult> {
    const original = await this.loadOwned(p.operatorId, p.originalId);
    if (original.printMode !== 'FAC') throw new BadRequestException('Reprint the original transaction');
    const result = await this.issue({
      operatorId: p.operatorId,
      deviceId: original.deviceId,
      userId: p.userId,
      relatedTransactionId: original.id,
      externalRef: original.externalRef,
      draft: {
        documentKind: original.documentKind as SaleDraft['documentKind'],
        typTrans: original.transactionType,
        modImpr: p.mode,
        formImpr: original.printFormat,
        modTrans: original.transactionMode,
        typServ: original.serviceType ?? undefined,
        noTabl: original.tableNumber ?? undefined,
        nbClint: original.numberOfCovers ?? undefined,
        ecommerce: original.ecommerce,
        modPai: original.paymentMode as PaymentCode,
        lines: this.linesOf(original),
        taxOverride: { tpsCents: original.tpsCents, tvqCents: original.tvqCents },
        tipCents: original.tipCents,
      },
      modification: { type: ModificationType.REPRINT, originalId: original.id, next: { mode: p.mode } },
      inTx: p.inTx,
    });
    await this.audit.log({ operatorId: p.operatorId, eventType: AuditEventType.TRANSACTION_REPRINTED, userId: p.userId, entityId: original.id, entityType: 'Transaction', description: `${p.mode} of transaction ${original.noTrans}` });
    return result;
  }

  /** Adding an item after invoicing: a new receipt for the added item, referencing the original. */
  async addItemAfterInvoice(operatorId: string, originalId: string, userId: string, item: { description: string; quantity: string; unitPriceCents: number; tax: TaxCode }, reason?: string) {
    const original = await this.loadOwned(operatorId, originalId);
    const line: SaleLine = { description: item.description, quantity: item.quantity, unitPriceCents: item.unitPriceCents, totalCents: lineTotal(item.unitPriceCents, item.quantity), tax: item.tax, activity: 'RES' };
    return this.issue({
      operatorId,
      deviceId: original.deviceId,
      userId,
      relatedTransactionId: original.id,
      externalRef: original.externalRef,
      draft: {
        documentKind: 'RECEIPT', typTrans: 'RFER', modImpr: 'FAC', formImpr: original.printFormat, modTrans: original.transactionMode,
        typServ: original.serviceType ?? undefined, ecommerce: original.ecommerce, modPai: original.paymentMode as PaymentCode, lines: [line],
      },
      modification: { type: ModificationType.ADD_ITEM, originalId, reason, next: line },
    });
  }

  /** Removing an item after invoicing: a credit note for that item. */
  async removeItemAfterInvoice(operatorId: string, originalId: string, itemId: string, userId: string, reason?: string) {
    const original = await this.loadOwned(operatorId, originalId);
    const item = original.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Item not found on this transaction');
    const [line] = this.linesOf({ ...original, items: [item] });
    return this.creditNote({ operatorId, originalId, userId, full: false, lines: [line], reason, modificationType: ModificationType.REMOVE_ITEM });
  }

  /** Changing a price after invoicing: credit note for the old line + new receipt at the new price, both referenced. */
  async modifyPriceAfterInvoice(operatorId: string, originalId: string, itemId: string, userId: string, newUnitPriceCents: number, reason?: string) {
    const original = await this.loadOwned(operatorId, originalId);
    const item = original.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Item not found on this transaction');
    if (!Number.isInteger(newUnitPriceCents) || newUnitPriceCents < 0) throw new BadRequestException('newUnitPriceCents must be a positive integer');
    const credit = await this.creditNote({ operatorId, originalId, userId, full: false, lines: this.linesOf({ ...original, items: [item] }), reason, modificationType: ModificationType.MODIFY_PRICE });
    const replacement = await this.addItemAfterInvoice(operatorId, originalId, userId, { description: item.description, quantity: item.quantity, unitPriceCents: newUnitPriceCents, tax: item.tax as TaxCode }, reason);
    return { creditNote: credit.transaction, replacement: replacement.transaction };
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async list(operatorId: string, take = 50) {
    return this.prisma.transaction.findMany({ where: { operatorId }, orderBy: { createdAt: 'desc' }, take: Math.min(take, 200), include: { items: { orderBy: { sortOrder: 'asc' } } } });
  }

  async dailySummary(operatorId: string, civilDate?: string) {
    const date = civilDate && /^\d{8}$/.test(civilDate) ? civilDate : civilTime().civilDate;
    const txs = await this.prisma.transaction.findMany({ where: { operatorId, civilDate: date, printMode: 'FAC', transactionMode: 'OPE' } });
    const sum = (f: (t: Transaction) => number) => txs.reduce((s, t) => s + f(t), 0);
    return {
      civilDate: date,
      transactionCount: txs.length,
      salesCents: sum((t) => (t.documentKind === 'RECEIPT' ? t.subtotalCents : 0)),
      creditNotesCents: sum((t) => (t.documentKind === 'CREDIT_NOTE' ? t.subtotalCents : 0)),
      tpsCents: sum((t) => t.tpsCents),
      tvqCents: sum((t) => t.tvqCents),
      byMevStatus: txs.reduce<Record<string, number>>((acc, t) => ((acc[t.mevStatus] = (acc[t.mevStatus] ?? 0) + 1), acc), {}),
    };
  }

  /** Runs the queue for every device that has waiting transactions (cron + manual flush). */
  async flushAll(): Promise<number> {
    const devices = await this.prisma.offlineQueue.findMany({ where: { status: QueueStatus.PENDING }, select: { deviceId: true }, distinct: ['deviceId'] });
    let accepted = 0;
    for (const d of devices) {
      try {
        accepted += (await this.submitDevice(d.deviceId)).accepted;
      } catch (e) {
        this.logger.warn(`flush of device ${d.deviceId} failed: ${safeErrorMessage(e)}`);
      }
    }
    return accepted;
  }
}
