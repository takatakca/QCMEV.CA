/**
 * WEB-SRM (MEV-WEB) client. The environment (SIMULATOR / DEV / ESSAI / PROD) comes from MEV_ENVIRONMENT
 * and decides the endpoint; nothing else can switch it.
 *
 * - Every request and answer is written to MevRequestLog after redaction (no authorization code, tax numbers,
 *   CSR, certificate or key ever reaches the log).
 * - A network failure, a timeout or a 5xx raises MevUnreachableError: the caller switches to offline mode.
 *   It is never stored as a rejection.
 */
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MevRequestType, Prisma } from '@prisma/client';
import type { KeyObject } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { redact, safeErrorMessage } from '../common/redact';
import { signP256 } from '../crypto/ecdsa';
import { PrismaService } from '../prisma/prisma.service';
import {
  MevHeaders,
  MevRequestKind,
  Modif,
  ReqCertif,
  ReqDoc,
  ReqTrans,
  ReqUtil,
  RetourCertif,
  RetourDoc,
  RetourTrans,
  RetourTransItem,
  RetourUtil,
  TransActu,
} from './mev-web.types';

export class MevUnreachableError extends Error {
  constructor(message: string, public readonly httpStatus?: number) {
    super(message);
    this.name = 'MevUnreachableError';
  }
}

export interface SigningMaterial {
  privateKey: KeyObject;
  certPem: string;
  thumbprint: string;
  mevDeviceId: string;
}

export interface OperatorIdentity {
  id: string;
  noTPS: string;
  noTVQ: string;
}

@Injectable()
export class MevWebService {
  private readonly logger = new Logger('MevWeb');
  private lastOkAt: Date | null = null;
  private lastFailAt: Date | null = null;

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
  ) {}

  /** Reachability as seen by the last real call (there is no public health endpoint on MEV-WEB; SPEC). */
  reachability(): { mevReachable: boolean | null; lastOkAt: Date | null; lastFailAt: Date | null } {
    const reachable = this.lastOkAt || this.lastFailAt ? (this.lastOkAt?.getTime() ?? 0) >= (this.lastFailAt?.getTime() ?? 0) : null;
    return { mevReachable: reachable, lastOkAt: this.lastOkAt, lastFailAt: this.lastFailAt };
  }

  baseHeaders(): MevHeaders {
    const s = this.cfg.sev;
    return {
      ENVIRN: this.cfg.envirnHeader,
      ...(this.cfg.mevEnvironment === 'ESSAI' ? { CASESSAI: this.cfg.casEssai } : {}),
      APPRLINIT: 'SRV',
      IDSEV: s.idSev,
      IDVERSI: s.idVersi,
      CODCERTIF: s.codCertif,
      IDPARTN: s.idPartn,
      VERSI: s.versi,
      VERSIPARN: s.versiParn,
    };
  }

  async certificateRequest(op: OperatorIdentity, authorizationCode: string, modif: Modif, csr: string, noSerie?: string): Promise<RetourCertif> {
    const body: ReqCertif = { reqCertif: { modif, csr, ...(noSerie ? { noSerie } : {}) } };
    const headers: MevHeaders = { ...this.baseHeaders(), CODAUTORI: authorizationCode, NOTPS: op.noTPS, NOTVQ: op.noTVQ };
    return (await this.post<RetourCertif>('CRT', op.id, headers, body)).data;
  }

  async userRequest(op: OperatorIdentity, m: SigningMaterial, modif: Modif, nomUtil: string): Promise<RetourUtil> {
    const body: ReqUtil = { reqUtil: { modif, nomUtil, noTax: op.noTVQ } };
    return (await this.post<RetourUtil>('UTL', op.id, this.signedHeaders(m), body, m)).data;
  }

  /** Sends one transaction (transActu) or a batch (transLot). Returns one result per transaction, in order. */
  async sendTransactions(op: OperatorIdentity, m: SigningMaterial, trans: TransActu[]): Promise<RetourTransItem[]> {
    if (!trans.length) return [];
    const body: ReqTrans = { reqTrans: trans.length === 1 ? { transActu: trans[0] } : { transLot: trans } };
    const { data } = await this.post<RetourTrans>('TRX', op.id, this.signedHeaders(m), body, m);
    const r = data?.retourTrans ?? {};
    const globalErrors = r.listErr ?? [];
    const items = trans.length === 1 ? [r.retourTransActu ?? {}] : r.retourTransLot ?? [];
    return trans.map((t, i) => {
      const item = items.find((x) => x?.noTrans === t.noTrans) ?? items[i] ?? {};
      return { ...item, listErr: [...globalErrors, ...(item.listErr ?? [])] };
    });
  }

  async documentRequest(op: OperatorIdentity, m: SigningMaterial, reqDoc: ReqDoc): Promise<RetourDoc> {
    return (await this.post<RetourDoc>('DOC', op.id, this.signedHeaders(m), reqDoc, m)).data;
  }

  private signedHeaders(m: SigningMaterial): MevHeaders {
    return { ...this.baseHeaders(), IDAPPRL: m.mevDeviceId, EMPRCERTIFTRANSM: m.thumbprint };
  }

  private async post<T>(kind: MevRequestKind, operatorId: string, headers: MevHeaders, body: unknown, signer?: SigningMaterial): Promise<{ status: number; data: T }> {
    const raw = JSON.stringify(body);
    const allHeaders: Record<string, string> = { 'Content-Type': 'application/json', ...(headers as unknown as Record<string, string>) };
    if (signer) allHeaders.SIGNATRANSM = signP256(signer.privateKey, raw);
    const url = `${this.cfg.mevBaseUrl}${this.cfg.mevPaths[kind]}`;
    const started = Date.now();
    const log = await this.prisma.mevRequestLog.create({
      data: {
        operatorId,
        requestType: kind as MevRequestType,
        environment: this.cfg.mevEnvironment,
        requestPayload: redact({ headers: allHeaders, body }) as Prisma.InputJsonValue,
      },
    });
    try {
      const res = await firstValueFrom(
        this.http.post<T>(url, raw, {
          headers: allHeaders,
          timeout: this.cfg.mevTimeoutMs,
          // 4xx answers carry MEV error lists; only 5xx and network errors mean "unreachable".
          validateStatus: (s) => s < 500,
          transformRequest: [(d) => d],
        }),
      );
      this.lastOkAt = new Date();
      const listErr = this.firstErrorCode(res.data);
      await this.prisma.mevRequestLog.update({
        where: { id: log.id },
        data: {
          responsePayload: redact(res.data ?? null) as Prisma.InputJsonValue,
          httpStatus: res.status,
          mevErrorCode: listErr,
          duration: Date.now() - started,
          success: res.status < 400 && !listErr,
        },
      });
      this.logger.log(`${kind} -> HTTP ${res.status}${listErr ? ` codRetour ${listErr}` : ''} (${Date.now() - started} ms)`);
      return { status: res.status, data: res.data };
    } catch (err) {
      this.lastFailAt = new Date();
      const status = (err as { response?: { status?: number } })?.response?.status;
      await this.prisma.mevRequestLog.update({
        where: { id: log.id },
        data: { httpStatus: status ?? null, mevErrorCode: 'UNREACHABLE', duration: Date.now() - started, success: false },
      });
      this.logger.warn(`${kind} unreachable: ${safeErrorMessage(err)}`);
      throw new MevUnreachableError(`MEV-WEB unreachable (${status ?? 'network'})`, status);
    }
  }

  private firstErrorCode(data: unknown): string | null {
    const seen: string[] = [];
    const walk = (v: unknown, depth: number) => {
      if (!v || typeof v !== 'object' || depth > 5 || seen.length) return;
      if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.listErr) && o.listErr.length) {
        const e = o.listErr[0] as { codRetour?: string };
        seen.push(String(e?.codRetour ?? 'ERR'));
        return;
      }
      Object.values(o).forEach((x) => walk(x, depth + 1));
    };
    walk(data, 0);
    return seen[0] ?? null;
  }
}
