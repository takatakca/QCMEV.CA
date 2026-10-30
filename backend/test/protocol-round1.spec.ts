/**
 * Round-1 review fixes of the official protocol layer, checked without a database:
 *  1. MEV-WEB requests are ASCII text (SW-76 §4.2), and SIGNATRANSM signs the bytes sent;
 *  2. the CSR L= value is the fixed UTC of the business address, never today's daylight-saving offset;
 *  3. an expired SEV certificate produces no invoice;
 *  4. the user report shows what Revenu Québec lists, and transmits the full sales summary;
 *  5. an HTTP 4xx without a listErr is a rejection (core-line rule), never an acceptance; 408 / 429 and a 2xx that is
 *     not a MEV-WEB answer are "unreachable" (offline mode).
 * The database flows (expired certificate holding the queue, the report on a real device) are in test/sw77.
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as x509 from '@peculiar/x509';
import { of, throwError } from 'rxjs';
import { isAscii, toAsciiJson } from '../src/common/ascii-json';
import { civilTime } from '../src/common/time';
import { loadConfig } from '../src/config/app-config';
import { addressUtcOf, csrSubjectString, generateKeyAndCsr } from '../src/crypto/csr';
import { FIRST_PRECED, generateP256, verifyP256 } from '../src/crypto/ecdsa';
import { SoftwareKeyCustody, softwareSigner } from '../src/crypto/key-custody';
import { CertificatesService } from '../src/certificates/certificates.service';
import { MevUnreachableError, MevWebService } from '../src/mev-web/mev-web.service';
import { classifyErrors, TransActu } from '../src/mev-web/mev-web.types';
import { sommVentesOf } from '../src/reports/reports';
import { formatEstablishmentAddress, maskRecipient, renderUserReport, renderUserReportText, UserReportInput, USER_REPORT_TITLE } from '../src/reports/user-report-renderer';
import { MevSimulatorService, SimRequestError } from '../src/simulator/mev-simulator.service';
import { LocationNotReadyError, TransactionsService } from '../src/transactions/transactions.service';
import { SaleDraft } from '../src/transactions/trans-builder';

/* eslint-disable @typescript-eslint/no-explicit-any */
const cfg = loadConfig({ JWT_SECRET: crypto.randomBytes(32).toString('hex'), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), MEV_SIMULATOR_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'qcmev-r1-')) });
const op = { id: 'op', noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001' };

function harness(answer: () => any) {
  const keys = generateP256();
  const sent: Array<{ url: string; raw: string; headers: Record<string, string> }> = [];
  const logs: any[] = [];
  const http = {
    post: (url: string, raw: string, opts: { headers: Record<string, string> }) => {
      sent.push({ url, raw, headers: opts.headers });
      return answer();
    },
  };
  const prisma = { mevRequestLog: { create: async () => ({ id: 'log' }), update: async (a: any) => (logs.push(a.data), {}) } };
  const svc = new MevWebService(cfg, http as any, prisma as any);
  const material = { sign: softwareSigner(keys.privateKeyPem).sign, certPem: '', thumbprint: 't', mevDeviceId: 'SIMDEV' };
  return { svc, sent, logs, material, publicKeyPem: keys.publicKeyPem };
}

const trx = (descr: string, nomUtil: string): TransActu =>
  ({
    noTrans: '1', datTrans: '20261024120000', utc: '-04:00', typTrans: 'RFER', modTrans: 'OPE', modImpr: 'FAC', formImpr: 'PAP', modPai: 'ARG',
    sectActi: { abrvt: 'RBC', typServ: 'CMP' }, commerElectr: 'N', nomUtil,
    items: [{ qte: '1', descr, unitr: '12.99', prix: '12.99', tax: 'FP', acti: 'RES' }],
    mont: { avantTax: '12.99', TPS: '0.65', TVQ: '1.30', apresTax: '14.94' },
    signa: { actu: 'x'.repeat(86) + '==', preced: FIRST_PRECED, datActu: '20261024120000' },
    noDossFO: 'ER0000', noTPS: op.noTPS, noTVQ: op.noTVQ,
  }) as TransActu;

describe('1. ASCII request text (SW-76 §4.2)', () => {
  it('toAsciiJson escapes every non-ASCII character and parses back to the same value', () => {
    const v = { descr: 'Poutine régulière', nomUtil: 'Hélène Côté', note: 'Crème brûlée 🍮', ctrl: 'a\u007fb' };
    const out = toAsciiJson(v);
    expect(isAscii(out)).toBe(true);
    expect(isAscii(JSON.stringify(v))).toBe(false);
    expect(out).toContain('r\\u00e9guli\\u00e8re');
    expect(out).toContain('\\ud83c\\udf6e'); // a surrogate pair, as JSON requires
    expect(JSON.parse(out)).toEqual(v);
  });

  it('the TRX body sent is ASCII, keeps the accents after parsing, and SIGNATRANSM verifies over those exact bytes', async () => {
    const h = harness(() => of({ status: 200, data: { retourTrans: { retourTransActu: { noTrans: '1', psiNoTrans: 'SIM1', psiDatTrans: '20261024120001' } } } }));
    const [r] = await h.svc.sendTransactions(op, h.material, [trx('Poutine régulière', 'Hélène')]);
    expect(classifyErrors(r.listErr)).toBe('accepted');
    const { raw, headers } = h.sent[0];
    expect(isAscii(raw)).toBe(true);
    expect(JSON.parse(raw).reqTrans.transActu.items[0].descr).toBe('Poutine régulière');
    expect(JSON.parse(raw).reqTrans.transActu.nomUtil).toBe('Hélène');
    expect(verifyP256(h.publicKeyPem, raw, headers.SIGNATRANSM)).toBe(true);
  });

  it('UTL with an accented user name is ASCII too', async () => {
    const h = harness(() => of({ status: 200, data: { retourUtil: { listErr: [] } } }));
    await h.svc.userRequest(op, h.material, 'AJO', 'Hélène Côté');
    expect(isAscii(h.sent[0].raw)).toBe(true);
  });

  it('the simulator refuses a request that is not ASCII', () => {
    const sim = new MevSimulatorService(cfg);
    let caught: unknown;
    try {
      sim.utilisateur({}, '{"reqUtil":{"nomUtil":"Hélène"}}', {});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SimRequestError);
    expect((caught as SimRequestError).errors.map((e) => e.id)).toEqual(['SIM-ASCII']);
  });
});

describe('5. HTTP answers: a 4xx is never "accepted"', () => {
  it.each([
    [400, {}],
    [401, ''],
    [403, { message: 'Forbidden' }],
    [404, '<html>Not Found</html>'],
    [400, { retourTrans: { listErr: [] } }],
  ])('TRX HTTP %s without a listErr → REJECTED (codRetour HTTP), logged as a failure', async (status, data) => {
    const h = harness(() => of({ status, data }));
    const [r] = await h.svc.sendTransactions(op, h.material, [trx('Poutine', 'staff')]);
    expect(r.listErr).toEqual([{ id: `HTTP-${status}`, mess: `MEV-WEB answered HTTP ${status} without an error list`, codRetour: 'HTTP' }]);
    expect(classifyErrors(r.listErr)).toBe('rejected');
    expect(r.psiNoTrans).toBeUndefined();
    expect(h.logs[0]).toMatchObject({ httpStatus: status, mevErrorCode: 'HTTP', success: false });
  });

  it('a 4xx that carries MEV-WEB errors keeps them (and their class)', async () => {
    const h = harness(() => of({ status: 400, data: { retourTrans: { retourTransActu: { noTrans: '1', listErr: [{ id: 'E1', mess: 'not sent', codRetour: '95' }] } } } }));
    const [r] = await h.svc.sendTransactions(op, h.material, [trx('Poutine', 'staff')]);
    expect(r.listErr).toEqual([{ id: 'E1', mess: 'not sent', codRetour: '95' }]);
    expect(classifyErrors(r.listErr)).toBe('retry_batch');
  });

  it.each([
    [408, {}],
    [429, { retourTrans: { listErr: [] } }],
    [200, '<html>captive portal</html>'],
    [200, {}],
    [204, ''],
  ])('HTTP %s (try again later, or not a MEV-WEB answer) → unreachable: offline mode, never accepted', async (status, data) => {
    const h = harness(() => of({ status, data }));
    await expect(h.svc.sendTransactions(op, h.material, [trx('Poutine', 'staff')])).rejects.toBeInstanceOf(MevUnreachableError);
    expect(h.logs[0]).toMatchObject({ httpStatus: status, success: false });
  });

  it('5xx and network errors stay unreachable', async () => {
    const h = harness(() => throwError(() => Object.assign(new Error('boom'), { response: { status: 503 } })));
    await expect(h.svc.sendTransactions(op, h.material, [trx('Poutine', 'staff')])).rejects.toBeInstanceOf(MevUnreachableError);
  });

  it('UTL HTTP 403 without a listErr is a refusal, so the user is never marked registered', async () => {
    const h = harness(() => of({ status: 403, data: '' }));
    const res = await h.svc.userRequest(op, h.material, 'AJO', 'staff');
    expect(classifyErrors(res.retourUtil.listErr)).toBe('rejected');
  });

  it('CRT and DOC get the same rule', async () => {
    const crt = harness(() => of({ status: 404, data: '<html/>' }));
    expect(classifyErrors((await crt.svc.certificateRequest(op, 'XXXX-XXXX', 'AJO', 'csr')).retourCertif.listErr)).toBe('rejected');
    const doc = harness(() => of({ status: 401, data: {} }));
    const reqDoc = { reqDoc: { typDoc: 'RUT' as const, noDossFO: 'ER0000', noTPS: op.noTPS, noTVQ: op.noTVQ, annee: 2026, datDoc: '20261024120000', sommVentes: sommVentesOf({ nbTrans: 0, nbTransPai: 0, avantTax: 0, tps: 0, tvq: 0, apresTax: 0, ajus: 0, mtdu: 0 }) } };
    expect(classifyErrors((await doc.svc.documentRequest(op, doc.material, reqDoc)).retourDoc.listErr)).toBe('rejected');
  });
});

describe('2. CSR L=: the fixed UTC of the business address', () => {
  it('-05:00 by default, -04:00 for Îles-de-la-Madeleine / Basse-Côte-Nord; nothing else', () => {
    expect(addressUtcOf({})).toBe('-05:00');
    expect(addressUtcOf({ addressUtc: null })).toBe('-05:00');
    expect(addressUtcOf({ addressUtc: '-04:00' })).toBe('-04:00');
    expect(() => addressUtcOf({ addressUtc: '-04:30' })).toThrow(RangeError);
    const s = { nickname: 'Certificat 0001', sector: 'RBC', authorizationCode: 'XXXX-XXXX', noTVQ: op.noTVQ, neq: '0000000000', fileNumber: 'ER0000' };
    expect(csrSubjectString({ ...s, utcOffset: '-05:00' })).toContain('L=-05:00');
    expect(() => csrSubjectString({ ...s, utcOffset: '+00:00' })).toThrow(RangeError);
  });

  it('the certificate request of a Montréal restaurant says -05:00 even in summer (daylight saving is -04:00)', async () => {
    expect(civilTime(new Date('2026-07-01T16:00:00Z')).utc).toBe('-04:00');
    expect(civilTime(new Date('2026-10-24T16:00:00Z')).utc).toBe('-04:00');
    const csrs: Record<string, string> = {};
    for (const addressUtc of [undefined, '-04:00']) {
      const device = { id: 'dev', operatorId: 'op', isActive: true, serialNumber: 'SN-1', fileNumber: 'ER0000', authorizationCodeEnc: 'enc', mevDeviceId: null, operator: { ...op, neq: '0000000000', sector: 'RBC', addressUtc } };
      const prisma = { device: { findFirst: async () => device } };
      const mevWeb = {
        certificateRequest: async (_o: unknown, _a: unknown, _m: unknown, csr: string) => {
          csrs[String(addressUtc)] = csr;
          return { retourCertif: { listErr: [{ id: 'X', mess: 'stop here', codRetour: '99' }] } };
        },
      };
      const vault = { decrypt: () => 'XXXX-XXXX', encrypt: () => 'e' } as any;
      const svc = new CertificatesService(prisma as any, mevWeb as any, { log: async () => undefined } as any, vault, new SoftwareKeyCustody(vault), cfg);
      await expect(svc.requestCertificate('op', 'dev')).rejects.toThrow();
    }
    const L = (b64: string) => new x509.Pkcs10CertificateRequest(Buffer.from(b64, 'base64')).subjectName.getField('L')[0];
    expect(L(csrs.undefined)).toBe('-05:00');
    expect(L(csrs['-04:00'])).toBe('-04:00');
  });

  it('the simulator refuses a CSR whose L= is a daylight-saving offset that is not an address UTC', async () => {
    const sim = new MevSimulatorService(cfg);
    const { csrPem } = await generateKeyAndCsr({ utcOffset: '-05:00', nickname: 'Certificat 0001', sector: 'RBC', authorizationCode: 'XXXX-XXXX', noTVQ: op.noTVQ, neq: '0000000000', fileNumber: 'ER0000' });
    const keys = (await crypto.webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
    const bad = await x509.Pkcs10CertificateRequestGenerator.create({ name: 'C=CA, ST=QC, L=-03:00, SN=Certificat 0001, O=RBC-XXXX-XXXX, CN=0000000000', keys, signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' } });
    const h = { envirn: 'DEV', apprlinit: 'SEV', idsev: 'a', idversi: 'b', codcertif: 'c', idpartn: 'd', versi: 'e', versiparn: 'f', codautori: 'XXXX-XXXX', notps: 'x', notvq: 'y' };
    const body = (pem: string) => ({ reqCertif: { modif: 'AJO', csr: pem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, '').replace(/\s+/g, '') } });
    const refused = await sim.enrolement(h, body(bad.toString('pem')), JSON.stringify(body(bad.toString('pem'))));
    expect(JSON.stringify(refused.body)).toContain('SIM-CSR-UTC');
    expect((await sim.enrolement(h, body(csrPem), JSON.stringify(body(csrPem)))).status).toBe(200);
  });
});

describe('3. an expired SEV certificate produces no invoice', () => {
  const draft: SaleDraft = {
    documentKind: 'RECEIPT', typTrans: 'RFER', modImpr: 'FAC', formImpr: 'PAP', modTrans: 'OPE', typServ: 'CMP', ecommerce: false, modPai: 'ARG',
    lines: [{ description: 'Poutine', quantity: '1', unitPriceCents: 1299, totalCents: 1299, tax: 'FP', activity: 'RES' }],
  };

  it('issue() refuses with 423 certReady before anything is signed, stored or sent, and audits it', async () => {
    const audit = { log: jest.fn(async () => undefined) };
    const prisma = {
      operator: { findUnique: async () => ({ ...op, environment: cfg.mevEnvironment }) },
      device: { findFirst: async () => ({ id: 'dev', isActive: true, fileNumber: 'ER0000' }) },
      sEVUser: { findFirst: async () => ({ id: 'u', isActive: true, mevUserName: 'staff', mevRegisteredAt: new Date() }) },
      $transaction: jest.fn(),
    };
    const certificates = {
      signingMaterial: async () => ({ expired: true, validUntil: new Date(Date.now() - 1000) }),
      mevWebCertificate: jest.fn(async () => 'pem'),
    };
    const mevWeb = { sendTransactions: jest.fn() };
    const svc = new TransactionsService(cfg, prisma as any, certificates as any, mevWeb as any, audit as any);
    const p = svc.issue({ operatorId: 'op', deviceId: 'dev', userId: 'u', draft });
    await expect(p).rejects.toBeInstanceOf(LocationNotReadyError);
    await expect(p).rejects.toMatchObject({ field: 'certReady' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(mevWeb.sendTransactions).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'MEV_ERROR', severity: 'CRITICAL' }));
  });
});

describe('4. user report: displayed contents and transmitted summary', () => {
  /** The 42-column lines read as one text: a value wrapped under its label joins it again. */
  const flat = (lines: string[]) => lines.join('\n').replace(/\n {2}/g, ' ');
  const input: UserReportInput = {
    merchantName: 'Restaurant Démo (données fictives)',
    noTPS: op.noTPS,
    noTVQ: op.noTVQ,
    userName: 'Hélène Côté',
    address: formatEstablishmentAddress({ address: '100-3800 boulevard Exemple', city: 'Montréal', postalCode: 'h1h 1h1' }),
    lastDocument: { noTrans: '42', totalCents: 1494, formImpr: 'PEL', recipientMasked: null, producedAt: '20261024120000', mevProcessedAt: '20261024120001', mevTransactionNumber: 'SIM000000042' },
    deviceId: 'SIMDEV',
    sevId: 'SEV-ID',
    sevVersion: '1.0.0',
    loginAt: '20261024110000',
    producedAt: '20261024121500',
    qrContent: 'http://127.0.0.1/qr?f=abc',
  };

  it('address: number, street, city, postal code, comma-separated, in that order', () => {
    expect(input.address).toBe('100-3800, boulevard Exemple, Montréal, H1H 1H1');
    expect(formatEstablishmentAddress({ address: 'Place sans numéro', city: 'Québec' })).toBe('Place sans numéro, Québec');
    expect(formatEstablishmentAddress({})).toBeNull();
  });

  it('recipient masks: four characters + six asterisks, or six asterisks + last four digits', () => {
    expect(maskRecipient('jean.tremblay@example.com')).toBe('jean******');
    expect(maskRecipient('514 555-1234')).toBe('******1234');
  });

  it('shows every item Revenu Québec lists, a QR code, and never the sales summary', async () => {
    const lines = renderUserReportText(input);
    expect(lines.every((l) => l.length <= 42)).toBe(true);
    const text = flat(lines);
    for (const expected of [
      USER_REPORT_TITLE, 'Restaurant Démo (données fictives)', `No TPS : ${op.noTPS}`, `No TVQ : ${op.noTVQ}`, 'Utilisateur : Hélène Côté',
      'Adresse : 100-3800, boulevard Exemple, Montréal, H1H 1H1', 'Dernier document produit', 'No de transaction : 42', 'Total avec taxes : 14,94 $',
      'Support : Papier et électronique', 'Destinataire : non conservé par le SEV', 'Produit le : 2026-10-24 12:00:00', 'Traité par le MEV-WEB : 2026-10-24 12:00:01',
      'No de transaction MEV-WEB : SIM000000042', "Identifiant de l'appareil : SIMDEV", 'Identifiant du SEV : SEV-ID', 'Version du SEV : 1.0.0',
      'Connexion au compte : 2026-10-24 11:00:00', 'Rapport produit le : 2026-10-24 12:15:00', '[CODE QR]',
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).not.toMatch(/Sommaire|avantTax|apresTax|Sous-total/);
    const r = await renderUserReport(input);
    expect(r.qr.pngDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(r.html).toContain('<svg');
  });

  it('offline last document: « PROBLÈME DE COMMUNICATION »; no document at all is said plainly', () => {
    const offline = flat(renderUserReportText({ ...input, lastDocument: { ...input.lastDocument!, formImpr: 'PAP', mevProcessedAt: null, mevTransactionNumber: null } }));
    expect(offline).toContain('Traité par le MEV-WEB : PROBLÈME DE COMMUNICATION');
    expect(offline).toContain('No de transaction MEV-WEB : PROBLÈME DE COMMUNICATION');
    expect(offline).not.toContain('Destinataire');
    expect(flat(renderUserReportText({ ...input, lastDocument: null }))).toContain('Aucun document produit sur cet appareil');
  });

  it('the transmitted summary carries the publicly listed content, amounts as MEV-WEB strings', () => {
    const sv = sommVentesOf({ nbTrans: 7, nbTransPai: 5, avantTax: 10000, tps: 500, tvq: 998, apresTax: 11498, ajus: 0, mtdu: 11498 });
    expect(sv).toEqual({ nbTrans: 7, nbTransPai: 5, avantTax: '100.00', TPS: '5.00', TVQ: '9.98', apresTax: '114.98', ajus: '0.00', mtdu: '114.98' });
    // Sent in the order of Revenu Québec's list.
    expect(Object.keys(sv)).toEqual(['nbTrans', 'nbTransPai', 'avantTax', 'TPS', 'TVQ', 'apresTax', 'ajus', 'mtdu']);
  });
});
