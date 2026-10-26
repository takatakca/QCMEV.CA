/**
 * Food Hub integration (contract foodhub.sale.v1): sales, credit notes, prints, status, health.
 *
 * Idempotency (contract §6):
 *  - one ExternalSale row per saleKey / creditKey / printKey, inserted in the SAME database transaction as the
 *    numbered Transaction, before MEV-WEB is called;
 *  - same key + same payloadHash → the answer is replayed (re-rendered from the stored transaction, so it also shows
 *    a later MEV acceptance); same key + different payloadHash → 409 idempotency_conflict (use a credit note);
 *  - a signed event id is remembered 24 h; the same event id with another body → 409 replay_conflict.
 * Timeouts are always safe to retry with the same key.
 */
import { BadRequestException, ConflictException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditEventType, ExternalSale, ExternalSaleKind, ExternalSaleStatus, LogSeverity, MevStatus, Prisma } from '@prisma/client';
import { APP_CONFIG, AppConfig } from '../../config/app-config';
import { CertificatesService } from '../../certificates/certificates.service';
import { AuditLogService } from '../../logging/audit-log.service';
import { MevWebService } from '../../mev-web/mev-web.service';
import { OfflineWatchService } from '../../offline/offline-watch.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ReceiptService } from '../../receipts/receipt.service';
import { saleTotals } from '../../transactions/trans-builder';
import { LocationNotReadyError, TransactionsService } from '../../transactions/transactions.service';
import {
  ContractError,
  FoodHubCreditV1,
  FoodHubPrintV1,
  FoodHubSaleV1,
  mapSale,
  payloadHashOf,
  toSaleLines,
  validateCredit,
  validatePrint,
  validateSale,
} from './foodhub.contract';
import type { SignedRequestInfo } from './foodhub.guard';

export const FOODHUB_AUTO = 'FOODHUB-AUTO';
export const FOODHUB_AUTO_EXTERNAL_ID = `foodhub:${FOODHUB_AUTO}`;

export interface ApiAnswer {
  httpStatus: number;
  body: Record<string, unknown>;
}

const STATUS_OF: Record<MevStatus, string> = {
  ACCEPTED: 'accepted',
  PENDING: 'offline_pending',
  OFFLINE_PENDING: 'offline_pending',
  RETRY_BATCH: 'offline_pending',
  REJECTED: 'rejected',
};

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

@Injectable()
export class FoodHubService {
  private readonly logger = new Logger('FoodHub');

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly prisma: PrismaService,
    private readonly txs: TransactionsService,
    private readonly receipts: ReceiptService,
    private readonly certificates: CertificatesService,
    private readonly offline: OfflineWatchService,
    private readonly mevWeb: MevWebService,
    private readonly audit: AuditLogService,
  ) {}

  // ─── Common ───────────────────────────────────────────────────────────────

  private checkIdempotencyHeader(info: SignedRequestInfo, key: string): void {
    if (info.idempotencyKey && info.idempotencyKey !== key && info.idempotencyKey !== info.eventId) {
      throw new BadRequestException({ statusCode: 400, error: 'idempotency_key_mismatch', message: 'Idempotency-Key must equal the body key or X-Event-Id' });
    }
  }

  /** Replay guard: an event id is accepted again only with the very same body. */
  private async rememberEvent(info: SignedRequestInfo, key: string): Promise<void> {
    const seen = await this.prisma.integrationEvent.findUnique({ where: { eventId: info.eventId } });
    if (seen) {
      if (seen.bodyHash !== info.bodyHash || seen.key !== key || seen.tenantId !== info.tenantId) {
        throw new ConflictException({ statusCode: 409, error: 'replay_conflict', message: 'this event id was already used with another body' });
      }
      return;
    }
    try {
      await this.prisma.integrationEvent.create({ data: { eventId: info.eventId, tenantId: info.tenantId, key, bodyHash: info.bodyHash } });
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      // Another request may win between findUnique and create. Apply exactly the same replay check to its row;
      // swallowing P2002 would let a different signed body proceed under an already-used event id.
      const winner = await this.prisma.integrationEvent.findUnique({ where: { eventId: info.eventId } });
      if (!winner || winner.bodyHash !== info.bodyHash || winner.key !== key || winner.tenantId !== info.tenantId) {
        throw new ConflictException({ statusCode: 409, error: 'replay_conflict', message: 'this event id was already used with another body' });
      }
    }
  }

  private payloadHash(body: Record<string, unknown>): string {
    const computed = payloadHashOf(body);
    if (body.payloadHash !== undefined && body.payloadHash !== computed) {
      throw new ContractError([{ field: 'payloadHash', message: 'does not match sha256 of the canonical JSON body' }]);
    }
    return computed;
  }

  private async location(tenantId: string, locationId: string) {
    const m = await this.prisma.locationMapping.findUnique({ where: { tenantId_locationId: { tenantId, locationId } } });
    if (!m || !m.isActive) throw new LocationNotReadyError('locationId', `location ${locationId} is not mapped to an SEV device`);
    return m;
  }

  /** The staff member who accepted (if registered with UTL), otherwise FOODHUB-AUTO. */
  private async userFor(operatorId: string, user: { id?: string } | undefined, warnings: string[]): Promise<string> {
    if (user?.id) {
      const staff = await this.prisma.sEVUser.findUnique({ where: { operatorId_externalId: { operatorId, externalId: `foodhub:${user.id}` } } });
      if (staff?.isActive && staff.mevRegisteredAt) return staff.id;
      warnings.push('userFallback');
    }
    const auto = await this.prisma.sEVUser.findUnique({ where: { operatorId_externalId: { operatorId, externalId: FOODHUB_AUTO_EXTERNAL_ID } } });
    if (!auto?.isActive || !auto.mevRegisteredAt) throw new LocationNotReadyError('usersReady', `${FOODHUB_AUTO} is not registered with MEV-WEB (UTL)`);
    return auto.id;
  }

  private async findKey(tenantId: string, key: string) {
    return this.prisma.externalSale.findUnique({ where: { tenantId_key: { tenantId, key } } });
  }

  private async replayOrConflict(existing: ExternalSale, payloadHash: string): Promise<ApiAnswer> {
    if (existing.payloadHash !== payloadHash) {
      throw new ConflictException({ statusCode: 409, error: 'idempotency_conflict', message: 'same key with a different payload: send a credit note instead', key: existing.key });
    }
    return this.render(existing);
  }

  /** Builds the answer from the stored transaction (deterministic for the same state). */
  private async render(ext: ExternalSale): Promise<ApiAnswer> {
    if (!ext.transactionId) return { httpStatus: HttpStatus.ACCEPTED, body: { status: 'queued', key: ext.key, retryAfterS: 5 } };
    const tx = await this.prisma.transaction.findUniqueOrThrow({ where: { id: ext.transactionId } });
    const receipt = await this.receipts.build(tx.id);
    const stored = (ext.responseJson ?? {}) as { warnings?: string[] };
    const body = {
      status: STATUS_OF[tx.mevStatus],
      kind: ext.kind.toLowerCase(),
      key: ext.key,
      saleKey: ext.saleKey,
      warnings: stored.warnings ?? [],
      errors: (tx.mevErrors as unknown as Array<{ id: string; mess: string; codRetour: string }>) ?? [],
      amounts: { subtotalCents: tx.subtotalCents, gstCents: tx.tpsCents, qstCents: tx.tvqCents, totalCents: tx.totalCents, tipCents: tx.tipCents ?? 0 },
      receipt,
    };
    if (ext.status !== ExternalSaleStatus.DONE || ext.httpStatus !== 200) {
      await this.prisma.externalSale.update({ where: { id: ext.id }, data: { status: ExternalSaleStatus.DONE, httpStatus: 200 } });
    }
    return { httpStatus: HttpStatus.OK, body };
  }

  private async rejectAudit(info: SignedRequestInfo, key: string, e: unknown): Promise<void> {
    if (e instanceof ContractError || e instanceof LocationNotReadyError) {
      await this.audit.log({
        eventType: AuditEventType.INTEGRATION_REJECTED,
        severity: LogSeverity.WARNING,
        entityType: 'FoodHub',
        entityId: key.slice(0, 190),
        description: `Food Hub ${info.tenantId}: ${e instanceof ContractError ? 'validation failed' : 'location not ready'}`,
        metadata: { errors: e instanceof ContractError ? e.errors : [{ field: e.field, message: e.message }] },
      });
    }
  }

  // ─── POST /sales ──────────────────────────────────────────────────────────

  async sale(info: SignedRequestInfo, body: FoodHubSaleV1): Promise<ApiAnswer> {
    const key = String(body?.saleKey ?? '');
    try {
      validateSale(body, info.tenantId);
      this.checkIdempotencyHeader(info, key);
      await this.rememberEvent(info, key);
      const payloadHash = this.payloadHash(body as unknown as Record<string, unknown>);
      const existing = await this.findKey(info.tenantId, key);
      if (existing) return this.replayOrConflict(existing, payloadHash);

      const loc = await this.location(info.tenantId, body.locationId);
      const mapped = mapSale(body);
      if (saleTotals(mapped.draft).taxGap) mapped.warnings.push('taxGap');
      let relatedTransactionId: string | null = null;
      if (body.referenceSaleKey) {
        const ref = await this.findKey(info.tenantId, body.referenceSaleKey);
        if (!ref || ref.kind !== ExternalSaleKind.SALE || !ref.transactionId) {
          throw new ContractError([{ field: 'referenceSaleKey', message: 'no receipt exists for this saleKey' }]);
        }
        relatedTransactionId = ref.transactionId;
      }
      const userId = await this.userFor(loc.operatorId, body.user, mapped.warnings);
      try {
        await this.txs.issue({
          operatorId: loc.operatorId,
          deviceId: loc.deviceId,
          userId,
          draft: mapped.draft,
          externalRef: mapped.externalRef,
          relatedTransactionId,
          occurredAt: new Date(body.occurredAt),
          inTx: async (tx, row) => {
            await tx.externalSale.create({
              data: { tenantId: info.tenantId, key, kind: ExternalSaleKind.SALE, saleKey: key, payloadHash, transactionId: row.id, responseJson: { warnings: mapped.warnings } },
            });
          },
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          const raced = await this.findKey(info.tenantId, key);
          if (raced) return this.replayOrConflict(raced, payloadHash);
        }
        throw e;
      }
      const ext = await this.findKey(info.tenantId, key);
      await this.audit.log({ operatorId: loc.operatorId, eventType: AuditEventType.INTEGRATION_SALE, deviceId: loc.deviceId, entityId: ext?.transactionId, entityType: 'Transaction', description: `Food Hub sale (${body.source.channel}, ${body.serviceType})` });
      return this.render(ext as ExternalSale);
    } catch (e) {
      await this.rejectAudit(info, key, e);
      throw e;
    }
  }

  // ─── POST /sales/:saleKey/credit-notes ────────────────────────────────────

  async credit(info: SignedRequestInfo, saleKey: string, body: FoodHubCreditV1): Promise<ApiAnswer> {
    const key = String(body?.creditKey ?? '');
    try {
      validateCredit(body, info.tenantId, saleKey);
      this.checkIdempotencyHeader(info, key);
      await this.rememberEvent(info, key);
      const payloadHash = this.payloadHash(body as unknown as Record<string, unknown>);
      const existing = await this.findKey(info.tenantId, key);
      if (existing) return this.replayOrConflict(existing, payloadHash);

      const sale = await this.findKey(info.tenantId, saleKey);
      if (!sale || sale.kind !== ExternalSaleKind.SALE || !sale.transactionId) throw new NotFoundException({ statusCode: 404, error: 'sale_not_found', message: 'no receipt for this saleKey yet' });
      const original = await this.prisma.transaction.findUniqueOrThrow({ where: { id: sale.transactionId } });
      const warnings: string[] = [];
      const userId = await this.userFor(original.operatorId, body.user, warnings);
      const lines = body.full ? undefined : toSaleLines(body.lines ?? []);
      if (lines && body.amounts && lines.reduce((s, l) => s + l.totalCents, 0) !== body.amounts.subtotalCents) {
        throw new ContractError([{ field: 'amounts.subtotalCents', message: 'must equal the sum of the credited lines' }]);
      }
      const taxMagnitudes = !body.full && body.amounts && Number.isInteger(body.amounts.gstCents) && Number.isInteger(body.amounts.qstCents)
        ? { tpsCents: body.amounts.gstCents as number, tvqCents: body.amounts.qstCents as number }
        : undefined;
      try {
        await this.txs.creditNote({
          operatorId: original.operatorId,
          originalId: original.id,
          userId,
          full: body.full,
          lines,
          taxMagnitudes,
          reason: body.reason,
          inTx: async (tx, row) => {
            await tx.externalSale.create({ data: { tenantId: info.tenantId, key, kind: ExternalSaleKind.CREDIT_NOTE, saleKey, payloadHash, transactionId: row.id, responseJson: { warnings } } });
          },
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          const raced = await this.findKey(info.tenantId, key);
          if (raced) return this.replayOrConflict(raced, payloadHash);
        }
        throw e;
      }
      return this.render((await this.findKey(info.tenantId, key)) as ExternalSale);
    } catch (e) {
      await this.rejectAudit(info, key, e);
      throw e;
    }
  }

  // ─── POST /sales/:saleKey/prints ──────────────────────────────────────────

  async print(info: SignedRequestInfo, saleKey: string, body: FoodHubPrintV1): Promise<ApiAnswer> {
    const key = String(body?.printKey ?? '');
    validatePrint(body, info.tenantId, saleKey);
    this.checkIdempotencyHeader(info, key);
    await this.rememberEvent(info, key);
    const payloadHash = this.payloadHash(body as unknown as Record<string, unknown>);
    const existing = await this.findKey(info.tenantId, key);
    if (existing) return this.replayOrConflict(existing, payloadHash);
    const sale = await this.findKey(info.tenantId, saleKey);
    if (!sale || sale.kind !== ExternalSaleKind.SALE || !sale.transactionId) throw new NotFoundException({ statusCode: 404, error: 'sale_not_found', message: 'no receipt for this saleKey yet' });
    const original = await this.prisma.transaction.findUniqueOrThrow({ where: { id: sale.transactionId } });
    const warnings: string[] = [];
    const userId = await this.userFor(original.operatorId, body.user, warnings);
    try {
      await this.txs.reprint({
        operatorId: original.operatorId,
        originalId: original.id,
        userId,
        mode: body.mode,
        inTx: async (tx, row) => {
          await tx.externalSale.create({ data: { tenantId: info.tenantId, key, kind: ExternalSaleKind.PRINT, saleKey, payloadHash, transactionId: row.id, responseJson: { warnings } } });
        },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const raced = await this.findKey(info.tenantId, key);
        if (raced) return this.replayOrConflict(raced, payloadHash);
      }
      throw e;
    }
    return this.render((await this.findKey(info.tenantId, key)) as ExternalSale);
  }

  // ─── GET /sales/:saleKey ──────────────────────────────────────────────────

  async getSale(info: SignedRequestInfo, saleKey: string): Promise<ApiAnswer> {
    const sale = await this.findKey(info.tenantId, saleKey);
    if (!sale || sale.kind !== ExternalSaleKind.SALE) throw new NotFoundException({ statusCode: 404, error: 'sale_not_found' });
    const main = await this.render(sale);
    const related = await this.prisma.externalSale.findMany({ where: { tenantId: info.tenantId, saleKey, kind: { not: ExternalSaleKind.SALE } }, orderBy: { createdAt: 'asc' } });
    const children = [];
    for (const r of related) {
      const a = await this.render(r);
      children.push({ kind: r.kind.toLowerCase(), key: r.key, status: a.body.status, receipt: a.body.receipt });
    }
    return { httpStatus: 200, body: { ...main.body, creditNotes: children.filter((c) => c.kind === 'credit_note'), prints: children.filter((c) => c.kind === 'print') } };
  }

  // ─── GET /health ──────────────────────────────────────────────────────────

  async health(info: SignedRequestInfo) {
    const maps = await this.prisma.locationMapping.findMany({ where: { tenantId: info.tenantId, isActive: true } });
    const locations = [];
    let validUntil: Date | null = null;
    for (const m of maps) {
      const r = await this.certificates.readiness(m.deviceId);
      const auto = await this.prisma.sEVUser.findUnique({ where: { operatorId_externalId: { operatorId: m.operatorId, externalId: FOODHUB_AUTO_EXTERNAL_ID } } });
      if (r.certificateValidUntil && (!validUntil || r.certificateValidUntil < validUntil)) validUntil = r.certificateValidUntil;
      locations.push({ locationId: m.locationId, deviceReady: r.deviceReady, certReady: r.certReady, usersReady: !!auto?.mevRegisteredAt && auto.isActive });
    }
    const q = await this.offline.status([...new Set(maps.map((m) => m.operatorId))]);
    return {
      status: 'ok',
      environment: this.cfg.mevEnvironment,
      certified: this.cfg.certified,
      certificateValidUntil: validUntil,
      mevReachable: this.mevWeb.reachability().mevReachable,
      queueDepth: q.queueDepth,
      oldestQueuedAt: q.oldestQueuedAt,
      locations,
    };
  }
}
