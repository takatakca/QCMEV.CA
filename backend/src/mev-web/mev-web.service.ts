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
} from './dto/mev-web.dto';
import { MevEnvironment, MevRequestType, AuditEventType, LogSeverity } from '@prisma/client';

// MEV-WEB endpoint URLs
const MEV_URLS: Record<MevEnvironment, string> = {
  SIMULATOR:   process.env.SIMULATOR_URL || 'http://localhost:3002',
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
   * Re-submit queued offline transactions in chronological order.
   * Called automatically when connectivity is restored.
   */
  async submitOfflineBatch(deviceId: string): Promise<{ submitted: number; failed: number }> {
    const pending = await this.prisma.offlineQueue.findMany({
      where: { deviceId, status: 'PENDING' },
      orderBy: { createdAt: 'asc' },
      include: { device: { include: { operator: true } } },
    });

    let submitted = 0;
    let failed = 0;

    for (const item of pending) {
      try {
        await this.prisma.offlineQueue.update({
          where: { id: item.id },
          data: { status: 'PROCESSING', lastAttemptAt: new Date() },
        });

        const payload = item.payload as TransactionRequestPayload;
        const operatorId = item.device.operatorId;
        const signed = await this.signAndPrepare(operatorId, payload);
        await this.sendToMevWeb<TransactionResponse>(
          operatorId,
          MevRequestType.TRX,
          MEV_ENDPOINTS.TRX,
          signed,
        );

        await this.prisma.offlineQueue.update({
          where: { id: item.id },
          data: { status: 'COMPLETED', processedAt: new Date() },
        });
        submitted++;
      } catch (err) {
        const attempts = item.attempts + 1;
        await this.prisma.offlineQueue.update({
          where: { id: item.id },
          data: {
            status: attempts >= item.maxAttempts ? 'FAILED' : 'PENDING',
            attempts,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
        });
        failed++;
        this.logger.warn(`Offline batch item ${item.id} failed (attempt ${attempts})`);
      }
    }

    return { submitted, failed };
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
      await this.prisma.mevRequestLog.update({
        where: { id: logEntry.id },
        data: {
          responsePayload: response.data as object,
          httpStatus: response.status,
          duration,
          success: true,
        },
      });

      this.logger.log(`MEV-WEB ${requestType} → ${response.status} (${duration}ms)`);
      return response.data;

    } catch (err: unknown) {
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
