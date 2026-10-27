import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CertificatesService } from '../certificates/certificates.service';
import { AuditLogService } from '../logging/audit-log.service';
import {
  MevRequestTypeCode,
  CertificateRequestPayload,
  CertificateResponse,
  UserRequestPayload,
  UserRequestResponse,
  TransactionRequestPayload,
  TransactionResponse,
  DocumentRequestPayload,
  DocumentResponse,
  MevWebError,
  MEV_ERROR_CODES,
  isTransientMevError,
} from './dto/mev-web.dto';
import { assertTransactionPayload } from './payload-validator';
import { MevWebHeader } from './dto/mev-web.dto';
import { quebecCivilDate, quebecTime } from './mev-time';
import {
  Operator,
  MevEnvironment,
  MevRequestType,
  AuditEventType,
  LogSeverity,
  MevStatus,
  QueueStatus,
  TransactionStatus,
} from '@prisma/client';

// MEV-WEB endpoint URLs
const MEV_URLS: Record<MevEnvironment, string> = {
  // The simulator is a controller inside this same backend (MevSimulatorController)
  SIMULATOR:   process.env.SIMULATOR_URL || `http://localhost:${process.env.PORT ?? 3001}/api/mev-simulator`,
  DEVELOPMENT: 'https://mev-web-dev.revenuquebec.ca/mev-web/v1',
  TESTING:     'https://mev-web-tst.revenuquebec.ca/mev-web/v1',
  PRODUCTION:  'https://mev-web.revenuquebec.ca/mev-web/v1',
};

const MEV_ENDPOINTS = {
  CRT: '/certificats',
  UTL: '/utilisateurs',
  TRX: '/transactions',
  DOC: '/documents',
};

@Injectable()
export class MevWebService {
  private readonly logger = new Logger(MevWebService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly certificatesService: CertificatesService,
    private readonly auditLogService: AuditLogService,
  ) {}

  // ─── Header ────────────────────────────────────────────────────────────────

  /**
   * Build the MEV-WEB request header (entete) for any request type.
   * Single source of truth — CRT, UTL, TRX and DOC all use it, so no request
   * ever leaves with an empty header. dateCivile / heureDebut are Québec local.
   * The signature is filled later by signAndPrepare().
   */
  buildHeader(
    operator: Pick<Operator, 'id' | 'sevCertificationCode' | 'sevVersion'>,
    typeRequete: MevRequestTypeCode,
    opts: { numeroAppareil?: string; typeAppareil?: string; dateCivile?: string; at?: Date } = {},
  ): MevWebHeader {
    const at = opts.at ?? new Date();
    return {
      typeRequete,
      codeSEV:        operator.sevCertificationCode ?? 'DEV-CODE',
      versionSEV:     operator.sevVersion,
      typeAppareil:   opts.typeAppareil ?? 'SERVEUR',
      numeroAppareil: opts.numeroAppareil ?? operator.id,
      dateCivile:     opts.dateCivile ?? quebecCivilDate(at),
      heureDebut:     quebecTime(at),
      signature:      '',
    };
  }

  // ─── Public Methods ────────────────────────────────────────────────────────

  async submitCertificateRequest(
    operatorId: string,
    payload: CertificateRequestPayload,
  ): Promise<CertificateResponse> {
    const signed = await this.signAndPrepare(operatorId, payload);
    return this.sendToMevWeb<CertificateResponse>(
      operatorId,
      MevRequestType.CRT,
      MEV_ENDPOINTS.CRT,
      signed,
    );
  }

  async submitUserRequest(
    operatorId: string,
    payload: UserRequestPayload,
  ): Promise<UserRequestResponse> {
    const signed = await this.signAndPrepare(operatorId, payload);
    return this.sendToMevWeb<UserRequestResponse>(
      operatorId,
      MevRequestType.UTL,
      MEV_ENDPOINTS.UTL,
      signed,
    );
  }

  async submitTransaction(
    operatorId: string,
    payload: TransactionRequestPayload,
  ): Promise<TransactionResponse> {
    assertTransactionPayload(payload);
    const signed = await this.signAndPrepare(operatorId, payload);
    return this.sendToMevWeb<TransactionResponse>(
      operatorId,
      MevRequestType.TRX,
      MEV_ENDPOINTS.TRX,
      signed,
    );
  }

  async submitDocument(
    operatorId: string,
    payload: DocumentRequestPayload,
  ): Promise<DocumentResponse> {
    const signed = await this.signAndPrepare(operatorId, payload);
    return this.sendToMevWeb<DocumentResponse>(
      operatorId,
      MevRequestType.DOC,
      MEV_ENDPOINTS.DOC,
      signed,
    );
  }

  /**
   * Re-submit queued offline transactions in chronological order (SW-76 §4.7).
   * Called automatically when connectivity is restored.
   *
   * - Each payload is validated at runtime before signing (queue = untyped JSON).
   * - Transient failure (network / 5xx): stop immediately, leave the rest PENDING,
   *   so transactions are never sent out of order. Never marked FAILED — a fiscal
   *   record must not be dropped because the network was down.
   * - Business rejection (4xx) or invalid payload: item FAILED, linked transaction
   *   REJECTED, continue with the next item.
   * - Success: item COMPLETED and the linked Transaction gets its MEV number,
   *   QR URL and certified data, exactly like a live submission.
   */
  async submitOfflineBatch(
    deviceId: string,
  ): Promise<{ submitted: number; failed: number; remaining: number }> {
    const pending = await this.prisma.offlineQueue.findMany({
      where: { deviceId, status: QueueStatus.PENDING },
      orderBy: { createdAt: 'asc' },
      include: { device: true },
    });

    let submitted = 0;
    let failed = 0;

    for (const item of pending) {
      const operatorId = item.device.operatorId;
      const attempts = item.attempts + 1;

      await this.prisma.offlineQueue.update({
        where: { id: item.id },
        data: { status: QueueStatus.PROCESSING, lastAttemptAt: new Date(), attempts },
      });

      try {
        const payload: unknown = item.payload;
        assertTransactionPayload(payload);

        // ANN / COR / NDC queued while the original was itself still queued:
        // its MEV number only exists now, after the original was flushed.
        const reference = await this.resolveOriginalReference(item.transactionId, payload);
        if (reference === 'WAIT') {
          await this.prisma.offlineQueue.update({
            where: { id: item.id },
            data: { status: QueueStatus.PENDING, errorMessage: 'Waiting for the original transaction MEV number' },
          });
          this.logger.warn(`Offline batch for device ${deviceId} paused at item ${item.id}: original not certified yet`);
          break;
        }

        const signed = await this.signAndPrepare(operatorId, payload);
        const response = await this.sendToMevWeb<TransactionResponse>(
          operatorId,
          MevRequestType.TRX,
          MEV_ENDPOINTS.TRX,
          signed,
        );

        await this.prisma.offlineQueue.update({
          where: { id: item.id },
          data: { status: QueueStatus.COMPLETED, processedAt: new Date(), errorMessage: null },
        });

        if (item.transactionId) {
          // A sale cancelled while still queued stays CANCELLED once certified
          const current = await this.prisma.transaction.findUnique({
            where: { id: item.transactionId },
            select: { status: true },
          });
          const cancelled = current?.status === TransactionStatus.CANCELLED;
          await this.prisma.transaction.update({
            where: { id: item.transactionId },
            data: {
              mevTransactionNumber: response.numeroTransactionMEV,
              mevSubmissionStatus:  MevStatus.ACCEPTED,
              mevSubmittedAt:       new Date(),
              mevResponse:          response as object,
              qrCodeUrl:            response.urlCodeQR,
              certifiedData:        response.donneeCertifiee,
              status:               cancelled ? TransactionStatus.CANCELLED : TransactionStatus.INVOICED,
              invoicedAt:           new Date(),
            },
          });
        }
        submitted++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        if (isTransientMevError(err)) {
          // Still offline — put it back and stop to preserve chronological order
          await this.prisma.offlineQueue.update({
            where: { id: item.id },
            data: { status: QueueStatus.PENDING, errorMessage: message },
          });
          this.logger.warn(`Offline batch for device ${deviceId} paused at item ${item.id}: ${message}`);
          break;
        }

        // Business rejection or invalid payload — will not succeed on retry
        await this.prisma.offlineQueue.update({
          where: { id: item.id },
          data: { status: QueueStatus.FAILED, errorMessage: message },
        });
        if (item.transactionId) {
          await this.prisma.transaction.update({
            where: { id: item.transactionId },
            data: { mevSubmissionStatus: MevStatus.REJECTED, mevResponse: { error: message } },
          });
        }
        await this.auditLogService.log({
          operatorId,
          eventType:   AuditEventType.MEV_SUBMISSION_FAILED,
          severity:    LogSeverity.ERROR,
          deviceId,
          entityId:    item.transactionId ?? item.id,
          entityType:  item.transactionId ? 'Transaction' : 'OfflineQueue',
          description: `Transaction hors ligne rejetée: ${message}`,
        });
        failed++;
      }
    }

    const remaining = await this.prisma.offlineQueue.count({
      where: { deviceId, status: QueueStatus.PENDING },
    });
    return { submitted, failed, remaining };
  }

  /**
   * Fill numeroTransactionOriginal from the original's MEV number when it was not
   * known at enqueue time. Returns 'WAIT' while the original is still queued;
   * throws (→ item FAILED) when the original was rejected and never will have one.
   */
  private async resolveOriginalReference(
    transactionId: string | null,
    payload: TransactionRequestPayload,
  ): Promise<'READY' | 'WAIT'> {
    if (!transactionId || payload.corps.transaction.numeroTransactionOriginal) return 'READY';

    const tx = await this.prisma.transaction.findUnique({
      where: { id: transactionId },
      select: { relatedTransactionId: true },
    });
    if (!tx?.relatedTransactionId) return 'READY';

    const original = await this.prisma.transaction.findUnique({
      where: { id: tx.relatedTransactionId },
      select: { mevTransactionNumber: true, mevSubmissionStatus: true },
    });
    if (original?.mevTransactionNumber) {
      payload.corps.transaction.numeroTransactionOriginal = original.mevTransactionNumber;
      return 'READY';
    }
    if (!original || original.mevSubmissionStatus === MevStatus.REJECTED) {
      throw new Error('Original transaction was rejected by MEV-WEB — nothing to reference');
    }
    return 'WAIT';
  }

  async checkMevWebConnectivity(operatorId: string): Promise<boolean> {
    try {
      const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
      if (!operator) return false;
      const baseUrl = MEV_URLS[operator.environment];
      await firstValueFrom(this.httpService.get(`${baseUrl}/health`, { timeout: 5000 }));
      return true;
    } catch {
      return false;
    }
  }

  // ─── Private Helpers ───────────────────────────────────────────────────────

  /**
   * Sign the payload and inject the signature into entete.signature.
   * Signature = RSA-SHA256(canonicalJSON(payload_without_signature)).
   * SW-76 §5.2 — canonical JSON = alphabetically sorted keys, no whitespace.
   */
  private async signAndPrepare<T extends { entete: { signature: string } }>(
    operatorId: string,
    payload: T,
  ): Promise<T> {
    const withoutSig = { ...payload, entete: { ...payload.entete, signature: '' } };
    const canonical = this.canonicalizeJson(withoutSig);
    const signature = await this.certificatesService.signData(operatorId, canonical);
    return { ...payload, entete: { ...payload.entete, signature } };
  }

  /**
   * Deterministic JSON serialization — keys sorted alphabetically at every level.
   * Required by SW-76 §5.2 for RSA-SHA256 signature verification.
   */
  canonicalizeJson(obj: unknown): string {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(v => this.canonicalizeJson(v)).join(',') + ']';
    const sorted = Object.keys(obj as object)
      .sort()
      .reduce((acc, key) => {
        acc[key] = (obj as Record<string, unknown>)[key];
        return acc;
      }, {} as Record<string, unknown>);
    return '{' + Object.entries(sorted)
      .map(([k, v]) => `${JSON.stringify(k)}:${this.canonicalizeJson(v)}`)
      .join(',') + '}';
  }

  /**
   * SHA-256 hash chain — links consecutive transactions per device per civil day.
   * hashChain = SHA256( previousHash || '|' || transactionData )
   */
  generateHashChain(previousHash: string, transactionData: string): string {
    return crypto
      .createHash('sha256')
      .update(`${previousHash}|${transactionData}`)
      .digest('hex');
  }

  async getPreviousTransactionHash(
    deviceId: string,
    civilDate: string,
    currentTransactionNumber: number,
  ): Promise<string> {
    if (currentTransactionNumber <= 1) {
      // Genesis hash — first transaction of the day
      return crypto.createHash('sha256').update(`GENESIS|${deviceId}|${civilDate}`).digest('hex');
    }
    const prev = await this.prisma.transaction.findFirst({
      where: {
        deviceId,
        civilDate,
        transactionNumber: currentTransactionNumber - 1,
      },
      select: { hashChain: true },
    });
    return prev?.hashChain ?? crypto.createHash('sha256').update(`GENESIS|${deviceId}|${civilDate}`).digest('hex');
  }

  /**
   * Send a signed payload to MEV-WEB, log the request/response, audit on error.
   */
  private async sendToMevWeb<TResponse>(
    operatorId: string,
    requestType: MevRequestType,
    endpoint: string,
    payload: unknown,
  ): Promise<TResponse> {
    const operator = await this.prisma.operator.findUnique({ where: { id: operatorId } });
    if (!operator) throw new Error('Operator not found');

    const baseUrl = MEV_URLS[operator.environment];
    const url = `${baseUrl}${endpoint}`;
    const startTime = Date.now();

    const logEntry = await this.prisma.mevRequestLog.create({
      data: {
        operatorId,
        requestType,
        environment: operator.environment,
        requestPayload: payload as object,
      },
    });

    try {
      const httpsAgent = await this.certificatesService.createHttpsAgent(operatorId);
      const response = await firstValueFrom(
        this.httpService.post<TResponse>(url, payload, {
          httpsAgent,
          headers: { 'Content-Type': 'application/json' },
          timeout: 30000,
        }),
      );

      const duration = Date.now() - startTime;
      // MEV-WEB answers business refusals with HTTP 200 and codeRetour ≠ "0": that is NOT a success
      const codeRetour = (response.data as any)?.codeRetour;
      const refused = codeRetour !== undefined && codeRetour !== null && String(codeRetour) !== '0';
      await this.prisma.mevRequestLog.update({
        where: { id: logEntry.id },
        data: {
          responsePayload: response.data as object,
          httpStatus: response.status,
          mevErrorCode: refused ? String(codeRetour) : null,
          duration,
          success: !refused,
        },
      });

      if (refused) {
        const mevMsg = (response.data as any)?.messageFr ?? MEV_ERROR_CODES[String(codeRetour)] ?? 'Refus MEV-WEB';
        await this.auditLogService.log({
          operatorId,
          eventType: AuditEventType.MEV_ERROR,
          severity: LogSeverity.ERROR,
          description: `MEV-WEB ${requestType} refusé (${codeRetour}): ${mevMsg}`,
          metadata: { mevCode: String(codeRetour), mevMsg, httpStatus: response.status, endpoint },
        });
        // httpStatus < 500 → isTransientMevError() = false: a refusal, never queued for retry
        throw new MevWebError(String(codeRetour), mevMsg, response.status);
      }

      this.logger.log(`MEV-WEB ${requestType} → ${response.status} (${duration}ms)`);
      return response.data;

    } catch (err: unknown) {
      if (err instanceof MevWebError) throw err; // refusal already logged above
      const duration = Date.now() - startTime;
      const httpStatus = (err as any)?.response?.status;
      const responseData = (err as any)?.response?.data;
      const mevCode = responseData?.codeRetour ?? 'NETWORK_ERROR';
      const mevMsg = responseData?.messageFr ?? MEV_ERROR_CODES['2000'];

      await this.prisma.mevRequestLog.update({
        where: { id: logEntry.id },
        data: {
          responsePayload: responseData ?? null,
          httpStatus,
          mevErrorCode: String(mevCode),
          duration,
          success: false,
        },
      });

      await this.auditLogService.log({
        operatorId,
        eventType: AuditEventType.MEV_ERROR,
        severity: LogSeverity.ERROR,
        description: `MEV-WEB ${requestType} failed: ${mevMsg}`,
        metadata: { mevCode, mevMsg, httpStatus, endpoint },
      });

      throw new MevWebError(String(mevCode), mevMsg, httpStatus);
    }
  }
}
