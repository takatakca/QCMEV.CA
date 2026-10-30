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
 * - Any other 4xx is a rejection (core-line rule, HANDOFF task 1). Only the error lists the callers read count: the
 *   retour* envelope's own listErr and, for TRX, the listErr of each retourTransActu / retourTransLot item
 *   (readableErrors). When a 4xx has none there (a gateway 401 / 403, a 404 from a wrong MEV_PATH_*, an HTML error
 *   page, or a listErr outside the envelope such as a top-level {listErr} or {erreur: {listErr}}), an error
 *   {codRetour "HTTP"} is put in the envelope; and in a 4xx batch answer, a transaction left without an error of its
 *   own gets it too. So the transaction is REJECTED (queue FAILED, audit), a user is never marked registered and a
 *   document is never ACCEPTED. A 4xx is never "accepted".
 */
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { MevRequestType, Prisma } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { toAsciiJson } from '../common/ascii-json';
import { redact, safeErrorMessage } from '../common/redact';
import { PrismaService } from '../prisma/prisma.service';
import {
  classifyErrors,
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

/** The listErr of one object of the answer, when it is a list (anything else is not an error list a caller reads). */
const listErrOf = (v: unknown): MevError[] => (isObject(v) && Array.isArray(v.listErr) ? (v.listErr as MevError[]) : []);

/**
 * The errors of an answer exactly where the callers read them: the envelope's own listErr (CRT, UTL, DOC; the TRX
 * global errors) and, for TRX, each item's listErr. A listErr anywhere else in the body is read by no caller, so it
 * never counts as "this 4xx carries its errors" (it stays visible in MevRequestLog.responsePayload).
 */
export function readableErrors(kind: MevRequestKind, answer: unknown): MevError[] {
  const env = isObject(answer) ? answer[ANSWER_ENVELOPE[kind]] : undefined;
  if (!isObject(env)) return [];
  const errors = [...listErrOf(env)];
  if (kind === 'TRX') {
    errors.push(...listErrOf(env.retourTransActu));
    if (Array.isArray(env.retourTransLot)) env.retourTransLot.forEach((item) => errors.push(...listErrOf(item)));
  }
  return errors;
}

/** Never settle a queued transaction from an absent, ambiguous or incomplete success acknowledgement. */
export function transactionAnswers(trans: TransActu[], answer: RetourTrans, status: number): RetourTransItem[] {
  const envelope = answer?.retourTrans;
  const globalErrors = listErrOf(envelope);
  const rawItems = trans.length === 1 ? [envelope?.retourTransActu] : envelope?.retourTransLot;
  const items: RetourTransItem[] = Array.isArray(rawItems) ? rawItems.filter(isObject) as RetourTransItem[] : [];
  const uniqueNumbers = new Set(trans.map((t) => t.noTrans));
  if (uniqueNumbers.size !== trans.length) throw new MevUnreachableError('ambiguous batch: transaction numbers must be distinct');
  return trans.map((t, i) => {
    const matches = items.filter((item) => item.noTrans === t.noTrans);
    // Preserve positional replies only when they omit noTrans entirely and contain every requested item.
    const positional = items.length === trans.length && items[i]?.noTrans === undefined ? items[i] : undefined;
    const item = matches.length === 1 ? matches[0] : matches.length === 0 ? positional : undefined;
    const errors = [...globalErrors, ...listErrOf(item)];
    const listErr = status >= 400 && !errors.length ? [httpRejection(status)] : errors;
    if (classifyErrors(listErr) === 'accepted' && (!item || typeof item.psiNoTrans !== 'string' || !item.psiNoTrans.trim())) {
      throw new MevUnreachableError('incomplete transaction acknowledgement: no unambiguous MEV-WEB number');
    }
    return { ...item, listErr };
  });
}

export interface SigningMaterial {
  /** The device key's signature of `data` (base64, 88 characters): software or Google Cloud KMS (crypto/key-custody.ts). */
  sign(data: string): Promise<string>;
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
    const { status, data } = await this.post<RetourTrans>('TRX', op.id, this.signedHeaders(m), body, m);
    return transactionAnswers(trans, data, status);
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
    if (signer) allHeaders.SIGNATRANSM = await signer.sign(raw);
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

    let data = answer as T;
    // Decided on the lists the callers read (readableErrors), never on a listErr found elsewhere in the body.
    let errors = readableErrors(kind, answer);
    if (res.status >= 400 && !errors.length) {
      // Core-line rule: a 4xx is a rejection. Without an error where the caller reads it, it would read as "accepted".
      const inner = hasEnvelope ? (answer as Record<string, Record<string, unknown>>)[envelope] : {};
      errors = [httpRejection(res.status)];
      data = { ...(isObject(answer) ? answer : {}), [envelope]: { ...inner, listErr: errors } } as T;
    }
    if (kind === 'TRX' && res.status < 400) {
      const request = (body as ReqTrans).reqTrans;
      try {
        transactionAnswers(request.transActu ? [request.transActu] : request.transLot ?? [], data as RetourTrans, res.status);
      } catch {
        return unreachable(res.status, 'INCOMPLETE_ACK', 'incomplete or ambiguous transaction acknowledgement');
      }
    }
    this.lastOkAt = new Date();
    const listErr = errors.length ? String(errors[0]?.codRetour ?? 'ERR') : null;
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
}
