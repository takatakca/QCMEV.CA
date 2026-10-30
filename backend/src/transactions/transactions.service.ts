/**
 * Issuance of every SEV transaction (staff sales, Food Hub sales, credit notes, reprints, post-invoice changes).
 *
 *   1. checks (operator, device, user registered with UTL, sale rules, a SEV certificate that has not expired: with an
 *      expired one no invoice is produced and nothing is transmitted, 423 certReady);
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
import { FIRST_PRECED, GENESIS_HASH, nextHashChain } from '../crypto/ecdsa';
import { CertificatesService, DeviceNotReadyError } from '../certificates/certificates.service';
import { AuditLogService } from '../logging/audit-log.service';
import { MevUnreachableError, MevWebService } from '../mev-web/mev-web.service';
import { classifyErrors, TransActu, TransCore } from '../mev-web/mev-web.types';
import { PrismaService } from '../prisma/prisma.service';
import { encryptQrPayload } from '../crypto/qr-crypto';
import { qrContent, qrPayload } from '../receipts/receipt-renderer';
import { assertTransActu, assertTransCore, InvalidMevPayloadError } from '../mev-web/payload-validator';
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
    // PROVEN (« Obtention et suppression d'un ou plusieurs certificats numériques », Expiration): with an expired
    // certificate the SEV can neither transmit nor « produire et remettre de factures ». No invoice is signed until the
    // certificate is replaced (CRT REM: POST /api/certificates/renew, or the nightly job before it expires).
    if (material.expired) {
      await this.audit.log({ operatorId, eventType: AuditEventType.MEV_ERROR, severity: LogSeverity.CRITICAL, userId, deviceId, description: 'invoice refused: the SEV certificate of this device has expired (renew it)', metadata: { validUntil: material.validUntil?.toISOString() ?? null } });
      throw new LocationNotReadyError('certReady', 'the SEV certificate of this device has expired: no invoice can be produced until it is renewed (CRT REM)');
    }
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
            utc: now.utc, // offset in force at datTrans (SPEC_GAPS #30); not the certificate's address UTC
            datActu: now.datTrans,
            nomUtil: user.mevUserName as string,
            preced,
            ref: related ? { noTrans: related.noTrans, datTrans: related.datTrans, subtotalCents: related.subtotalCents } : undefined,
          },
          { noTPS: operator.noTPS, noTVQ: operator.noTVQ },
        );
        const signature = await material.sign(signedString);
        const full: TransCore = { ...core, signa: { actu: signature, preced, datActu: now.datTrans } };
        // Never store (and later send) a transaction that would fail the runtime check.
        assertTransCore(full);
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

  /**
   * Offline-mode semantics (SW-76 §4.7), per device:
   *  - MEV-WEB unreachable (network, timeout, 5xx): nothing is lost or rejected; the transactions stay signed and
   *    queued (OFFLINE_PENDING), the device enters offline mode (offlineSince, audit OFFLINE_MODE_ACTIVATED);
   *  - the queue is sent in chain order, in batches (transLot) of up to 100, until it is empty or a batch fails;
   *    a transaction refused by MEV-WEB is REJECTED and its queue entry FAILED (audit MEV_ERROR), never retried;
   *  - every answer is written back to its Transaction row (MEV number psiNoTrans, psiDatTrans, errors);
   *  - a stored transaction that fails the runtime check is never sent: REJECTED + FAILED + CRITICAL audit, and the
   *    flush stops there so the chain order is kept;
   *  - the device goes back online only once its queue is empty (audit BATCH_SUBMITTED for each batch sent while
   *    offline, then OFFLINE_MODE_DEACTIVATED with the offline duration; lastSyncAt set).
   */
  private async submitDeviceNow(deviceId: string): Promise<{ sent: number; accepted: number; offline: boolean }> {
    let sent = 0;
    let accepted = 0;
    for (let round = 0; round < 50; round++) {
      const r = await this.submitBatch(deviceId);
      sent += r.sent;
      accepted += r.accepted;
      if (r.offline) return { sent, accepted, offline: true };
      // Expired certificate: nothing may be transmitted; the queue waits for the renewal (no sync, no lastSyncAt).
      if (r.certificateExpired) return { sent, accepted, offline: false };
      // Stop when nothing was sent, or nothing moved (every item answered "not sent": next flush).
      if (!r.sent || !r.settled || r.halted) break;
    }
    await this.syncDeviceState(deviceId);
    return { sent, accepted, offline: false };
  }

  /**
   * One transActu / transLot. `settled` = transactions accepted or rejected (they leave the queue).
   * `certificateExpired` = nothing was sent because the device certificate has expired (PROVEN: an expired certificate
   * cannot transmit). The transactions signed before the expiry stay queued, untouched, and go out after the renewal.
   */
  private async submitBatch(deviceId: string): Promise<{ sent: number; accepted: number; settled: number; offline: boolean; halted: boolean; certificateExpired?: boolean }> {
    const entries = await this.prisma.offlineQueue.findMany({
      where: { deviceId, status: QueueStatus.PENDING, transactionId: { not: null } },
      include: { transaction: true },
      orderBy: { transaction: { deviceSeq: 'asc' } },
      take: 100,
    });
    const ordered = entries.filter((e) => e.transaction).sort((a, b) => a.transaction!.deviceSeq - b.transaction!.deviceSeq).slice(0, 100);
    if (!ordered.length) return { sent: 0, accepted: 0, settled: 0, offline: false, halted: false };

    const device = await this.prisma.device.findUniqueOrThrow({ where: { id: deviceId }, include: { operator: true } });
    const op = device.operator;
    const now = new Date();

    // Runtime check of every stored transaction, in chain order; the first invalid one is refused locally and the
    // batch stops just before it.
    const pending: typeof ordered = [];
    const trans: TransActu[] = [];
    let halted = false;
    for (const e of ordered) {
      const t = { ...(e.transaction!.requestJson as Record<string, unknown>), noDossFO: device.fileNumber ?? '', noTPS: op.noTPS, noTVQ: op.noTVQ };
      try {
        assertTransActu(t);
      } catch (err) {
        const problems = err instanceof InvalidMevPayloadError ? err.problems : [safeErrorMessage(err)];
        await this.prisma.$transaction([
          this.prisma.transaction.update({ where: { id: e.transactionId as string }, data: { mevStatus: MevStatus.REJECTED, mevErrors: [{ id: 'QCMEV-PAYLOAD', mess: problems.join('; ').slice(0, 500), codRetour: 'LOCAL' }] as unknown as Prisma.InputJsonValue } }),
          this.prisma.offlineQueue.update({ where: { id: e.id }, data: { status: QueueStatus.FAILED, processedAt: now, errorMessage: `invalid stored transaction: ${problems.join('; ')}`.slice(0, 500) } }),
        ]);
        await this.audit.log({ operatorId: op.id, eventType: AuditEventType.MEV_ERROR, severity: LogSeverity.CRITICAL, deviceId, entityId: e.transactionId, entityType: 'Transaction', description: `transaction ${e.transaction!.noTrans} not sent: the stored transaction fails the runtime check`, metadata: { problems } });
        halted = true;
        break;
      }
      // Numbering restarts each civil day. A batch spanning midnight may contain "1" twice, while replies only
      // identify noTrans: split before the duplicate so no response can be written onto the wrong fiscal record.
      if (trans.some((previous) => previous.noTrans === t.noTrans)) break;
      pending.push(e);
      trans.push(t);
    }
    if (!pending.length) return { sent: 0, accepted: 0, settled: 1, offline: false, halted };

    const material = await this.certificates.signingMaterial(deviceId);
    if (material.expired) {
      this.logger.warn(`device ${device.serialNumber}: certificate expired, ${pending.length} queued transaction(s) wait for the renewal`);
      await this.prisma.offlineQueue.updateMany({ where: { id: { in: pending.map((e) => e.id) } }, data: { errorMessage: 'certificate expired: waiting for the renewal (CRT REM)' } });
      return { sent: 0, accepted: 0, settled: 0, offline: false, halted, certificateExpired: true };
    }
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
        await this.audit.log({ operatorId: op.id, eventType: AuditEventType.OFFLINE_MODE_ACTIVATED, severity: LogSeverity.WARNING, deviceId, description: `MEV-WEB unreachable: device ${device.serialNumber} in offline mode (transactions signed locally, sent within 48 h)`, metadata: { offlineSince: now.toISOString(), reason: e.message } });
      }
      await this.prisma.offlineQueue.updateMany({ where: { id: { in: pending.map((p) => p.id) } }, data: { errorMessage: e.message } });
      return { sent: pending.length, accepted: 0, settled: 0, offline: true, halted };
    }

    let accepted = 0;
    let rejected = 0;
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
        rejected++;
        await this.prisma.$transaction([
          this.prisma.transaction.update({ where: { id: txId }, data: { mevStatus: MevStatus.REJECTED, mevSubmittedAt: now, mevErrors: (r.listErr ?? []) as unknown as Prisma.InputJsonValue } }),
          this.prisma.offlineQueue.update({ where: { id: entry.id }, data: { status: QueueStatus.FAILED, processedAt: now, errorMessage: (r.listErr ?? []).map((x) => `${x.codRetour} ${x.id}`).join(', ').slice(0, 500) } }),
        ]);
        await this.audit.log({ operatorId: op.id, eventType: AuditEventType.MEV_ERROR, severity: LogSeverity.ERROR, deviceId, entityId: txId, entityType: 'Transaction', description: `transaction ${entry.transaction!.noTrans} rejected by MEV-WEB`, metadata: { errors: r.listErr ?? [] } });
      }
    }
    if (device.offlineMode) {
      await this.audit.log({
        operatorId: op.id,
        eventType: AuditEventType.BATCH_SUBMITTED,
        severity: rejected ? LogSeverity.WARNING : LogSeverity.INFO,
        deviceId,
        description: `offline queue sent: ${pending.length} transaction(s), ${accepted} accepted, ${rejected} rejected`,
        metadata: { sent: pending.length, accepted, rejected },
      });
    }
    return { sent: pending.length, accepted, settled: accepted + rejected, offline: false, halted };
  }

  /** After a successful exchange: lastSyncAt, and back online only when nothing is left in the device's queue. */
  private async syncDeviceState(deviceId: string): Promise<void> {
    const device = await this.prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    const remaining = await this.prisma.offlineQueue.count({ where: { deviceId, status: QueueStatus.PENDING } });
    const now = new Date();
    if (device.offlineMode && remaining === 0) {
      await this.prisma.device.update({ where: { id: deviceId }, data: { offlineMode: false, offlineSince: null, lastSyncAt: now } });
      await this.audit.log({
        operatorId: device.operatorId,
        eventType: AuditEventType.OFFLINE_MODE_DEACTIVATED,
        deviceId,
        description: `device ${device.serialNumber} back online (offline queue empty)`,
        metadata: { offlineSince: device.offlineSince?.toISOString() ?? null, backOnlineAt: now.toISOString(), offlineDurationMs: device.offlineSince ? now.getTime() - device.offlineSince.getTime() : null },
      });
    } else if (!device.offlineMode) {
      await this.prisma.device.update({ where: { id: deviceId }, data: { lastSyncAt: now } });
    }
  }

  // ─── Credit notes, reprints, post-invoice changes ─────────────────────────

  async loadOwned(operatorId: string, id: string): Promise<TxWithItems> {
    const tx = await this.prisma.transaction.findFirst({ where: { id, operatorId }, include: { items: { orderBy: { sortOrder: 'asc' } } } });
    if (!tx) throw new NotFoundException('Transaction not found');
    return tx;
  }

  /**
   * An original that a new transaction may reference (credit note, reprint, post-invoice change, corrected invoice).
   * The reference (refs: noTrans, datTrans, avantTax) is the original's own, fixed when it was signed, so an original
   * still waiting in the offline queue can be referenced: the new transaction is signed at once and queued behind it
   * (chain order). An original REJECTED by MEV-WEB cannot be referenced.
   */
  async loadReferenceable(operatorId: string, id: string): Promise<TxWithItems> {
    const tx = await this.loadOwned(operatorId, id);
    if (tx.mevStatus === MevStatus.REJECTED) throw new BadRequestException('The referenced transaction was rejected by MEV-WEB: there is nothing to reference');
    return tx;
  }

  /** « Facture corrigée »: the receipt being corrected must be an original receipt that has been credited. Returns its id. */
  async assertCorrectable(operatorId: string, id: string): Promise<string> {
    const tx = await this.loadReferenceable(operatorId, id);
    if (tx.documentKind !== DocumentKind.RECEIPT || tx.printMode !== 'FAC') throw new BadRequestException('Only an original receipt can be corrected');
    if (tx.status !== TransactionStatus.CREDITED && tx.status !== TransactionStatus.PARTIALLY_CREDITED) {
      throw new BadRequestException('Credit the receipt first (credit note), then issue the corrected receipt');
    }
    return tx.id;
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
    const original = await this.loadReferenceable(p.operatorId, p.originalId);
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
      inTx: async (tx, row) => {
        // Credit limits must be checked inside the transaction, not only before issuance. Two concurrent refunds
        // (including from different devices/processes) otherwise both see the same remaining balance.
        await tx.$queryRaw`SELECT id FROM "Transaction" WHERE id = ${original.id} FOR UPDATE`;
        const existing = await tx.transaction.aggregate({
          where: { relatedTransactionId: original.id, documentKind: DocumentKind.CREDIT_NOTE, id: { not: row.id } },
          _sum: { subtotalCents: true, tpsCents: true, tvqCents: true, totalCents: true },
        });
        const alreadyCredited = existing._sum.subtotalCents ?? 0;
        if (p.full && alreadyCredited !== 0) throw new BadRequestException('This sale already has a credit note; credit the remaining lines instead');
        const balance = original.subtotalCents + alreadyCredited;
        if (sum > balance) throw new SaleRuleError('lines', `credit (${mevAmount(sum)}) exceeds what remains on the sale (${mevAmount(balance)})`);
        for (const field of ['tpsCents', 'tvqCents', 'totalCents'] as const) {
          const remainingAmount = original[field] + (existing._sum[field] ?? 0);
          if (-row[field] > remainingAmount) throw new SaleRuleError(field, `credit exceeds the remaining ${field} on the sale`);
        }
        await tx.transaction.update({
          where: { id: original.id },
          data: { status: sum >= balance ? TransactionStatus.CREDITED : TransactionStatus.PARTIALLY_CREDITED },
        });
        if (p.inTx) await p.inTx(tx, row);
      },
    });
    await this.audit.log({ operatorId: p.operatorId, eventType: AuditEventType.TRANSACTION_CREDITED, userId: p.userId, entityId: original.id, entityType: 'Transaction', description: `credit note ${result.transaction.noTrans} on transaction ${original.noTrans}${p.reason ? `: ${p.reason}` : ''}` });
    return result;
  }

  /** Reproduction (RPR, for the customer) or duplicate (DUP, merchant copy). Both are transmitted. */
  async reprint(p: { operatorId: string; originalId: string; userId: string; mode: 'RPR' | 'DUP'; inTx?: IssueRequest['inTx'] }): Promise<IssueResult> {
    const original = await this.loadReferenceable(p.operatorId, p.originalId);
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
    const original = await this.loadReferenceable(operatorId, originalId);
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
    const original = await this.loadReferenceable(operatorId, originalId);
    const item = original.items.find((i) => i.id === itemId);
    if (!item) throw new NotFoundException('Item not found on this transaction');
    const [line] = this.linesOf({ ...original, items: [item] });
    return this.creditNote({ operatorId, originalId, userId, full: false, lines: [line], reason, modificationType: ModificationType.REMOVE_ITEM });
  }

  /** Changing a price after invoicing: credit note for the old line + new receipt at the new price, both referenced. */
  async modifyPriceAfterInvoice(operatorId: string, originalId: string, itemId: string, userId: string, newUnitPriceCents: number, reason?: string) {
    const original = await this.loadReferenceable(operatorId, originalId);
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
    const txs = await this.prisma.transaction.findMany({ where: { operatorId, civilDate: date, printMode: 'FAC', transactionMode: 'OPE', transactionType: 'RFER' } });
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
