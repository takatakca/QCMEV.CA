/**
 * Local WEB-SRM simulator (SIMULATOR / DEV only; never mounted in ESSAI or PROD).
 *
 * It is OUR test double, not Revenu Québec's behaviour: it checks the public rules we know (headers present,
 * ECDSA P-256 signatures of the request and of each transaction, the signature chain, amounts, duplicate numbers,
 * e-commerce payment rule) and issues real X.509 certificates from a throwaway local CA so CRT works end to end.
 * Passing here proves nothing about conformity; only Revenu Québec's DEV / ESSAI environments can.
 * QR codes point to this local simulator, never to a Revenu Québec or mev-web domain.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as x509 from '@peculiar/x509';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { computeTaxes } from '../common/money';
import { civilTime } from '../common/time';
import { certThumbprint, FIRST_PRECED, SIGNATURE_RE, transactionSignedString, verifyP256 } from '../crypto/ecdsa';
import { P256_ALG } from '../crypto/csr';
import { decryptQrPayload } from '../crypto/qr-crypto';
import type { MevError, TransActu } from '../mev-web/mev-web.types';
import { SimulatorStore } from './simulator-state';

const AMOUNT = /^-?\d+\.\d{2}$/;
const PAY = new Set(['ARG', 'CHQ', 'CRE', 'DEB', 'CPR', 'MIX', 'AUT', 'INC', 'AUC']);

function cents(a: string | undefined): number {
  if (!a || !AMOUNT.test(a)) return NaN;
  const neg = a.startsWith('-');
  const [i, d] = a.replace('-', '').split('.');
  return (neg ? -1 : 1) * (Number(i) * 100 + Number(d));
}

export interface SimResponse {
  status: number;
  body: unknown;
}

export class SimRequestError extends Error {
  constructor(public readonly errors: MevError[], public readonly status = 400) {
    super(errors.map((e) => e.mess).join('; '));
  }
}

const err = (id: string, mess: string, codRetour = '92'): MevError => ({ id: `SIM-${id}`, mess, codRetour });

@Injectable()
export class MevSimulatorService {
  private readonly logger = new Logger('MevSimulator');
  private readonly store: SimulatorStore;
  /** Fault switches for tests. */
  mevDown = false;
  notSentNext = 0;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {
    this.store = new SimulatorStore(cfg.simulatorStateDir, cfg.port);
  }

  // ─── CA ────────────────────────────────────────────────────────────────────

  private async ca(): Promise<{ key: CryptoKey; cert: x509.X509Certificate; certPem: string }> {
    const s = this.store.get();
    if (!s.ca) {
      const keys = (await crypto.webcrypto.subtle.generateKey(P256_ALG, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
      const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: crypto.randomBytes(8).toString('hex'),
        name: 'CN=QCMEV LOCAL SIMULATOR CA - NOT REVENU QUEBEC, O=Takatak MEV test double',
        notBefore: new Date(Date.now() - 60_000),
        notAfter: new Date(Date.now() + 3 * 365 * 86400_000),
        keys,
        signingAlgorithm: P256_ALG,
        extensions: [new x509.BasicConstraintsExtension(true, 0, true)],
      });
      const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey as unknown as crypto.webcrypto.CryptoKey));
      s.ca = { keyPem: crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString(), certPem: cert.toString('pem') };
      this.store.save();
    }
    const der = crypto.createPrivateKey(s.ca.keyPem).export({ type: 'pkcs8', format: 'der' });
    const key = (await crypto.webcrypto.subtle.importKey('pkcs8', der, P256_ALG, false, ['sign'])) as unknown as CryptoKey;
    return { key, cert: new x509.X509Certificate(s.ca.certPem), certPem: s.ca.certPem };
  }

  // ─── Common header checks ─────────────────────────────────────────────────

  private checkHeaders(h: Record<string, string | undefined>, needDevice: boolean): MevError[] {
    const errors: MevError[] = [];
    if (!['DEV', 'ESSAI'].includes(h.envirn ?? '')) errors.push(err('ENVIRN', 'ENVIRN must be DEV or ESSAI for the simulator'));
    // QCMEV creates, numbers and signs its own transactions: it is a SEV talking to MEV-WEB directly (mode SEV, SW-76
    // §4.1.2). "SRV" is for a remote server that only forwards transactions and has its own certificate.
    if (h.apprlinit !== 'SEV') errors.push(err('APPRLINIT', 'APPRLINIT must be SEV (QCMEV runs in mode SEV)'));
    for (const k of ['idsev', 'idversi', 'codcertif', 'idpartn', 'versi', 'versiparn']) {
      if (!h[k]) errors.push(err(k.toUpperCase(), `header ${k.toUpperCase()} is missing`));
    }
    if (needDevice) {
      if (!h.idapprl) errors.push(err('IDAPPRL', 'IDAPPRL is missing'));
      if (!h.signatransm || !SIGNATURE_RE.test(h.signatransm)) errors.push(err('SIGNATRANSM', 'SIGNATRANSM must be an 88-character ECDSA signature'));
      if (!h.emprcertiftransm) errors.push(err('EMPRCERTIFTRANSM', 'EMPRCERTIFTRANSM is missing'));
    }
    return errors;
  }

  private authDevice(h: Record<string, string | undefined>, rawBody: string) {
    const errors = this.checkHeaders(h, true);
    if (errors.length) throw new SimRequestError(errors);
    const dev = this.store.get().devices[h.idapprl as string];
    if (!dev) throw new SimRequestError([err('IDAPPRL-UNKNOWN', 'unknown device (IDAPPRL); run CRT first')], 401);
    if (dev.thumbprint !== h.emprcertiftransm) throw new SimRequestError([err('EMPRCERTIF', 'certificate thumbprint does not match the device')], 401);
    if (!verifyP256(dev.certPem, rawBody, h.signatransm as string)) throw new SimRequestError([err('SIGNATRANSM-INVALID', 'request signature does not verify')], 401);
    return dev;
  }

  // ─── CRT ───────────────────────────────────────────────────────────────────

  async enrolement(h: Record<string, string | undefined>, body: { reqCertif?: { modif?: string; csr?: string } }): Promise<SimResponse> {
    const errors = this.checkHeaders(h, false);
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(h.codautori ?? '')) errors.push(err('CODAUTORI', 'CODAUTORI must look like XXXX-XXXX'));
    if (!h.notps || !h.notvq) errors.push(err('NOTAX', 'NOTPS and NOTVQ headers are required'));
    const req = body?.reqCertif;
    if (req?.modif !== 'AJO') errors.push(err('MODIF', 'only modif AJO is simulated'));
    if (!req?.csr) errors.push(err('CSR', 'csr is missing'));
    if (errors.length) return { status: 400, body: { retourCertif: { listErr: errors } } };

    let csr: x509.Pkcs10CertificateRequest;
    try {
      const pem = `-----BEGIN CERTIFICATE REQUEST-----\n${(req!.csr as string).match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE REQUEST-----`;
      csr = new x509.Pkcs10CertificateRequest(pem);
      if (!(await csr.verify())) throw new Error('bad signature');
    } catch {
      return { status: 400, body: { retourCertif: { listErr: [err('CSR-INVALID', 'CSR cannot be read or its signature is invalid')] } } };
    }
    const alg = csr.publicKey.algorithm as EcKeyAlgorithm;
    if (alg.name !== 'ECDSA' || alg.namedCurve !== 'P-256') {
      return { status: 400, body: { retourCertif: { listErr: [err('CSR-ALG', 'the key must be ECDSA P-256')] } } };
    }
    const o = csr.subjectName.getField('O')[0] ?? '';
    if (o !== `RBC-${h.codautori}`) {
      return { status: 400, body: { retourCertif: { listErr: [err('CSR-SUBJECT', 'CSR subject O must be <sector>-<authorization code>')] } } };
    }

    const ca = await this.ca();
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: crypto.randomBytes(16).toString('hex'),
      subject: csr.subjectName,
      issuer: ca.cert.subject,
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 2 * 365 * 86400_000),
      signingAlgorithm: P256_ALG,
      publicKey: csr.publicKey,
      signingKey: ca.key,
    });
    const certPem = cert.toString('pem');
    const idApprl = `SIM${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    this.store.get().devices[idApprl] = { certPem, thumbprint: certThumbprint(certPem), lastSignature: null, users: [], seen: {}, counter: 0 };
    this.store.save();
    this.logger.log(`[SIM] CRT issued for device ${idApprl}`);
    return { status: 200, body: { retourCertif: { idApprl, certif: cert.toString('base64'), certifPSI: ca.cert.toString('base64'), listErr: [] } } };
  }

  // ─── UTL ───────────────────────────────────────────────────────────────────

  utilisateur(h: Record<string, string | undefined>, rawBody: string, body: { reqUtil?: { modif?: string; nomUtil?: string; noTax?: string } }): SimResponse {
    const dev = this.authDevice(h, rawBody);
    const r = body?.reqUtil;
    const errors: MevError[] = [];
    if (!r?.nomUtil || r.nomUtil.length > 50) errors.push(err('NOMUTIL', 'nomUtil is missing or too long'));
    if (!r?.noTax) errors.push(err('NOTAX', 'noTax is missing'));
    if (!['AJO', 'SUP', 'VAL'].includes(r?.modif ?? '')) errors.push(err('MODIF', 'modif must be AJO, SUP or VAL'));
    if (!errors.length) {
      const name = r!.nomUtil as string;
      if (r!.modif === 'AJO' && !dev.users.includes(name)) dev.users.push(name);
      if (r!.modif === 'SUP') dev.users = dev.users.filter((u) => u !== name);
      if (r!.modif === 'VAL' && !dev.users.includes(name)) errors.push(err('UTIL-UNKNOWN', 'user not registered'));
      this.store.save();
    }
    return { status: errors.length ? 400 : 200, body: { retourUtil: { listErr: errors } } };
  }

  // ─── TRX ───────────────────────────────────────────────────────────────────

  transaction(h: Record<string, string | undefined>, rawBody: string, body: { reqTrans?: { transActu?: TransActu; transLot?: TransActu[] } }): SimResponse {
    const dev = this.authDevice(h, rawBody);
    const single = body?.reqTrans?.transActu;
    const lot = body?.reqTrans?.transLot;
    const list = single ? [single] : Array.isArray(lot) ? lot : [];
    if (!list.length) return { status: 400, body: { retourTrans: { listErr: [err('REQTRANS', 'reqTrans needs transActu or transLot')] } } };

    if (this.notSentNext > 0) {
      this.notSentNext--;
      const items = list.map((t) => ({ noTrans: t.noTrans, listErr: [err('NOT-SENT', 'transaction not recorded, send it again with the next one', '95')] }));
      return { status: 200, body: { retourTrans: single ? { retourTransActu: items[0] } : { retourTransLot: items } } };
    }

    const results = list.map((t) => this.oneTransaction(h.idapprl as string, dev, t));
    this.store.save();
    return { status: 200, body: { retourTrans: single ? { retourTransActu: results[0] } : { retourTransLot: results } } };
  }

  private oneTransaction(idApprl: string, dev: ReturnType<SimulatorStore['get']>['devices'][string], t: TransActu) {
    const errors: MevError[] = [];
    const need = (cond: boolean, id: string, mess: string) => { if (!cond) errors.push(err(id, mess)); };
    need(/^\d{14}$/.test(t.datTrans ?? ''), 'DATTRANS', 'datTrans must be AAAAMMJJhhmmss');
    need(['-04:00', '-05:00'].includes(t.utc), 'UTC', 'utc must be -04:00 or -05:00');
    need(!!t.noTrans && t.noTrans.length <= 10, 'NOTRANS', 'noTrans is missing or longer than 10 characters');
    need(['ADDI', 'ESTM', 'RFER', 'SOUM'].includes(t.typTrans), 'TYPTRANS', 'typTrans is invalid');
    need(['OPE', 'FOR'].includes(t.modTrans), 'MODTRANS', 'modTrans is invalid');
    need(['FAC', 'RPR', 'DUP', 'ANN', 'PSP'].includes(t.modImpr), 'MODIMPR', 'modImpr is invalid');
    need(['PAP', 'ELE', 'PEL', 'NON'].includes(t.formImpr), 'FORMIMPR', 'formImpr is invalid');
    need(PAY.has(t.modPai), 'MODPAI', 'modPai is invalid');
    need(t.sectActi?.abrvt === 'RBC', 'SECTACTI', 'sectActi.abrvt must be RBC');
    need(!t.sectActi?.typServ || ['CMP', 'LVR', 'LVT', 'TBL'].includes(t.sectActi.typServ), 'TYPSERV', 'typServ is invalid');
    need(['O', 'N'].includes(t.commerElectr), 'COMMERELECTR', 'commerElectr must be O or N');
    need(!(t.commerElectr === 'O' && ['ARG', 'CHQ'].includes(t.modPai)), 'COMMERELECTR-PAI', 'cash or cheque is not allowed when commerElectr=O');
    need(!!t.noDossFO && !!t.noTPS && !!t.noTVQ, 'IDENT', 'noDossFO, noTPS and noTVQ are required');
    need(dev.users.includes(t.nomUtil), 'NOMUTIL', 'nomUtil is not a registered user (UTL)');
    need(Array.isArray(t.items) && t.items.length > 0, 'ITEMS', 'at least one item is required');

    const m = t.mont ?? ({} as TransActu['mont']);
    const av = cents(m.avantTax), tps = cents(m.TPS), tvq = cents(m.TVQ), ap = cents(m.apresTax);
    need(![av, tps, tvq, ap].some(Number.isNaN), 'MONT-FORMAT', 'amounts must be decimal strings with 2 decimals');
    if (![av, tps, tvq, ap].some(Number.isNaN)) {
      need(ap === av + tps + tvq, 'MONT-APRESTAX', 'apresTax must equal avantTax + TPS + TVQ (the tip is never included)');
      const lines = (t.items ?? []).map((i) => ({ totalCents: cents(i.prix), tax: i.tax }));
      if (!lines.some((l) => Number.isNaN(l.totalCents))) {
        const c = computeTaxes(lines);
        need(c.subtotalCents === av, 'MONT-AVANTTAX', 'avantTax must equal the sum of the items');
        need(Math.abs(c.tpsCents - tps) <= 1 && Math.abs(c.tvqCents - tvq) <= 1, 'MONT-TAX', 'TPS / TVQ do not match the items (more than 1 cent)');
      } else {
        errors.push(err('ITEM-PRIX', 'item amounts must be decimal strings with 2 decimals'));
      }
      if (m.pourb !== undefined) need(cents(m.pourb) >= 0, 'MONT-POURB', 'pourb must be a positive amount');
      if (t.typTrans === 'RFER' && ap < 0) need(Array.isArray(t.refs) && t.refs.length > 0, 'REFS', 'a credit note must reference the original transaction');
    }
    if (['RPR', 'DUP'].includes(t.modImpr)) need(Array.isArray(t.refs) && t.refs.length > 0, 'REFS-COPY', 'a reproduction or duplicate must reference the original');

    const dupKey = `${(t.datTrans ?? '').slice(0, 8)}|${t.noTrans}`;
    need(!dev.seen[dupKey], 'NOTRANS-DUP', 'noTrans already used on this device for this civil day');

    const preced = t.signa?.preced;
    const expectedPreced = dev.lastSignature ?? FIRST_PRECED;
    need(SIGNATURE_RE.test(t.signa?.actu ?? ''), 'SIGNA-FORMAT', 'signa.actu must be 88 base64 characters');
    need(preced === expectedPreced, 'SIGNA-PRECED', 'signa.preced does not match the previous signature of this device');
    const signed = transactionSignedString({
      noTrans: t.noTrans, datTrans: t.datTrans, TPS: m.TPS, TVQ: m.TVQ, apresTax: m.apresTax,
      noTPS: t.noTPS, noTVQ: t.noTVQ, modImpr: t.modImpr, modTrans: t.modTrans, preced: preced ?? '',
    });
    const signatureOk = verifyP256(dev.certPem, signed, t.signa?.actu ?? '');
    need(signatureOk, 'SIGNA-INVALID', 'signa.actu does not verify with the device certificate');
    // The chain follows every correctly signed transaction, even one refused for another reason.
    if (signatureOk && preced === expectedPreced) dev.lastSignature = t.signa.actu;

    if (errors.length) return { noTrans: t.noTrans, listErr: errors };

    dev.counter += 1;
    const psiNoTrans = `SIM${String(dev.counter).padStart(9, '0')}`;
    dev.seen[dupKey] = psiNoTrans;
    this.store.get().transactions[`${idApprl}|${dupKey}`] = { idApprl, noTrans: t.noTrans, datTrans: t.datTrans, apresTax: m.apresTax, psiNoTrans };
    return { noTrans: t.noTrans, psiNoTrans, psiDatTrans: civilTime().datTrans, listErr: [] };
  }

  // ─── DOC ───────────────────────────────────────────────────────────────────

  document(h: Record<string, string | undefined>, rawBody: string, body: { reqDoc?: { typDoc?: string; annee?: number } }): SimResponse {
    this.authDevice(h, rawBody);
    const d = body?.reqDoc;
    if (d?.typDoc !== 'RUT' || !Number.isInteger(d?.annee)) {
      return { status: 400, body: { retourDoc: { listErr: [err('REQDOC', 'only typDoc RUT with a year is simulated')] } } };
    }
    const s = this.store.get();
    s.docs += 1;
    this.store.save();
    return { status: 200, body: { retourDoc: { noDoc: `SIMDOC${String(s.docs).padStart(6, '0')}`, listErr: [] } } };
  }

  /** The QR link data, decrypted with MEV-WEB's (here: the simulator CA's) private key. */
  lookupQr(f: string): Record<string, string> | null {
    try {
      const ca = this.store.get().ca;
      if (!ca) return null;
      const data = JSON.parse(decryptQrPayload(ca.keyPem, f)) as { a: string; n: string; d: string };
      const tx = this.store.get().transactions[`${data.a}|${data.d.slice(0, 8)}|${data.n}`];
      return tx ? { ...tx } : { pending: 'not received yet', ...data };
    } catch {
      return null;
    }
  }
}
