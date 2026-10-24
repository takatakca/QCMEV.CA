/**
 * WEB-SRM (MEV-WEB) client. The environment (SIMULATOR / DEV / ESSAI / PROD) comes from MEV_ENVIRONMENT
 * and decides the endpoint; nothing else can switch it.
 *
 * - Every request and answer is written to MevRequestLog after redaction (no authorization code, tax numbers,
 *   CSR, certificate or key ever reaches the log).
 * - The request body is ASCII text (SW-76 §4.2): accents are sent as JSON \uXXXX escapes (common/ascii-json.ts), and
 *   SIGNATRANSM signs exactly those bytes.
 * - A network failure, a timeout, a 5xx, a 408 / 429 ("try again later") or a 2xx that is not a MEV-WEB answer (no
 *   retour* envelope, e.g. a proxy page) raises MevUnreachableError: the caller switches to offline mode. It is never
 *   stored as a rejection, and never as an acceptance.
 * - Any other 4xx is a rejection (core-line rule, HANDOFF task 1): when its body carries no listErr (a gateway 401 /
 *   403, a 404 from a wrong MEV_PATH_*, an HTML error page), an error {codRetour "HTTP"} is put in the answer, so the
 *   transaction is REJECTED (queue FAILED, audit) and a user is never marked registered. It is never "accepted".
 */
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MevRequestType, Prisma } from '@prisma/client';
import type { KeyObject } from 'crypto';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { toAsciiJson } from '../common/ascii-json';
import { redact, safeErrorMessage } from '../common/redact';
import { signP256 } from '../crypto/ecdsa';
import { PrismaService } from '../prisma/prisma.service';
import {
  MevError,
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

/** The answer envelope of each request kind (S1 names). */
export const ANSWER_ENVELOPE: Record<MevRequestKind, 'retourCertif' | 'retourUtil' | 'retourTrans' | 'retourDoc'> = {
  CRT: 'retourCertif',
  UTL: 'retourUtil',
  TRX: 'retourTrans',
  DOC: 'retourDoc',
};

/** 4xx statuses that mean "try again later" (request timeout, too many requests): unreachable, never a rejection. */
export const TRANSIENT_4XX: ReadonlySet<number> = new Set([408, 429]);

/** The error put in a 4xx answer that has no listErr of its own. "HTTP" does not end in 0, 1 or 5: a rejection. */
export function httpRejection(status: number): MevError {
  return { id: `HTTP-${status}`, mess: `MEV-WEB answered HTTP ${status} without an error list`, codRetour: 'HTTP' };
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

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
      // Mode SEV (SW-76 §4.1.2): QCMEV creates, numbers and signs every transaction and sends it itself. A remote
      // server (SRV) may only forward transactions made by a SEV, with its own certificate: not what QCMEV is.
      APPRLINIT: 'SEV',
      IDSEV: s.idSev,
      IDVERSI: s.idVersi,
      CODCERTIF: s.codCertif,
      IDPARTN: s.idPartn,
      VERSI: s.versi,
      VERSIPARN: s.versiParn,
    };
  }

  /**
   * CRT. AJO = first certificate of a device. REM = replacement of the device's current certificate (renewal): it
   * carries the 40-character noSerie of the certificate being replaced and is signed with that certificate's key, so
   * the device keeps its IDAPPRL and its signature chain (SPEC: REM / noSerie names from the 2022 sample, S1; the
   * exact renewal rules wait for SW-73).
   */
  async certificateRequest(op: OperatorIdentity, authorizationCode: string, modif: Modif, csr: string, noSerie?: string, signer?: SigningMaterial): Promise<RetourCertif> {
    const body: ReqCertif = { reqCertif: { modif, csr, ...(noSerie ? { noSerie } : {}) } };
    const headers: MevHeaders = { ...(signer ? this.signedHeaders(signer) : this.baseHeaders()), CODAUTORI: authorizationCode, NOTPS: op.noTPS, NOTVQ: op.noTVQ };
    return (await this.post<RetourCertif>('CRT', op.id, headers, body, signer)).data;
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
    // SW-76 §4.2: ASCII text only. SIGNATRANSM covers exactly the bytes sent.
    const raw = toAsciiJson(body);
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
    const unreachable = async (status: number | undefined, code: string, why: string): Promise<never> => {
      this.lastFailAt = new Date();
      await this.prisma.mevRequestLog.update({
        where: { id: log.id },
        data: { httpStatus: status ?? null, mevErrorCode: code, duration: Date.now() - started, success: false },
      });
      this.logger.warn(`${kind} unreachable: ${why}`);
      throw new MevUnreachableError(`MEV-WEB unreachable (${status ?? 'network'})`, status);
    };

    let res: { status: number; data: T };
    try {
      res = await firstValueFrom(
        this.http.post<T>(url, raw, {
          headers: allHeaders,
          timeout: this.cfg.mevTimeoutMs,
          // 4xx answers are read below (rejections, or "try again later"); 5xx and network errors mean "unreachable".
          validateStatus: (s) => s < 500,
          transformRequest: [(d) => d],
        }),
      );
    } catch (err) {
      return unreachable((err as { response?: { status?: number } })?.response?.status, 'UNREACHABLE', safeErrorMessage(err));
    }

    const envelope = ANSWER_ENVELOPE[kind];
    const answer: unknown = res.data;
    const hasEnvelope = isObject(answer) && isObject(answer[envelope]);
    if (TRANSIENT_4XX.has(res.status)) return unreachable(res.status, 'UNREACHABLE', `HTTP ${res.status} (try again later)`);
    // A 2xx without the answer envelope did not come from MEV-WEB's service (proxy, captive portal, wrong host):
    // nothing was recorded, so nothing is accepted; the transactions stay queued and are sent again.
    if (res.status < 400 && !hasEnvelope) return unreachable(res.status, 'NOT_MEV_ANSWER', `HTTP ${res.status} without ${envelope}`);

    this.lastOkAt = new Date();
    let data = answer as T;
    let listErr = this.firstErrorCode(answer);
    if (res.status >= 400 && !listErr) {
      // Core-line rule: a 4xx is a rejection. Without a listErr of its own it would otherwise read as "accepted".
      const inner = hasEnvelope ? (answer as Record<string, Record<string, unknown>>)[envelope] : {};
      data = { ...(isObject(answer) ? answer : {}), [envelope]: { ...inner, listErr: [httpRejection(res.status)] } } as T;
      listErr = 'HTTP';
    }
    await this.prisma.mevRequestLog.update({
      where: { id: log.id },
      data: {
        responsePayload: redact(isObject(answer) ? answer : { nonJsonBody: true }) as Prisma.InputJsonValue,
        httpStatus: res.status,
        mevErrorCode: listErr,
        duration: Date.now() - started,
        success: res.status < 400 && !listErr,
      },
    });
    this.logger.log(`${kind} -> HTTP ${res.status}${listErr ? ` codRetour ${listErr}` : ''} (${Date.now() - started} ms)`);
    return { status: res.status, data };
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
