/**
 * Round-2 review fix of the official protocol layer, checked without a database: a 4xx is never "accepted", even when
 * its body carries a listErr OUTSIDE the place the callers read (a top-level {listErr}, {erreur: {listErr}}), and in a
 * 4xx batch answer no transaction is left without an error. The decision is made on readableErrors(): the retour*
 * envelope's own listErr and, for TRX, each item's listErr: exactly what sendTransactions, OperatorsService
 * (retourUtil.listErr), CertificatesService (retourCertif.listErr) and ReportsService (retourDoc.listErr) read.
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { of } from 'rxjs';
import { loadConfig } from '../src/config/app-config';
import { FIRST_PRECED, generateP256, signP256 } from '../src/crypto/ecdsa';
import { softwareSigner } from '../src/crypto/key-custody';
import { httpRejection, MevWebService, readableErrors } from '../src/mev-web/mev-web.service';
import { classifyErrors, TransActu } from '../src/mev-web/mev-web.types';
import { OperatorsService } from '../src/operators/operators';
import { sommVentesOf } from '../src/reports/reports';
import { buildTransCore } from '../src/transactions/trans-builder';
import { TransactionsService } from '../src/transactions/transactions.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const cfg = loadConfig({ JWT_SECRET: crypto.randomBytes(32).toString('hex'), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), MEV_SIMULATOR_STATE_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'qcmev-r2-')) });
const op = { id: 'op', noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001' };
const gw = (codRetour = '99') => [{ id: 'GW', mess: 'header error', codRetour }];

function harness(status: number, data: unknown) {
  const keys = generateP256();
  const logs: any[] = [];
  const http = { post: () => of({ status, data }) };
  const prisma = { mevRequestLog: { create: async () => ({ id: 'log' }), update: async (a: any) => (logs.push(a.data), {}) } };
  const svc = new MevWebService(cfg, http as any, prisma as any);
  const material = { sign: softwareSigner(keys.privateKeyPem).sign, certPem: '', thumbprint: 't', mevDeviceId: 'SIMDEV' };
  return { svc, logs, material };
}

const trans = (n: number) => Array.from({ length: n }, (_, i) => ({ noTrans: String(i + 1) }) as unknown as TransActu);
const reqDoc = { reqDoc: { typDoc: 'RUT' as const, noDossFO: 'ER0000', noTPS: op.noTPS, noTVQ: op.noTVQ, annee: 2026, datDoc: '20261024120000', sommVentes: sommVentesOf({ nbTrans: 0, nbTransPai: 0, avantTax: 0, tps: 0, tvq: 0, apresTax: 0, ajus: 0, mtdu: 0 }) } };

describe('readableErrors: only where the callers read', () => {
  it('reads the envelope listErr, and for TRX each item listErr; nothing else in the body', () => {
    expect(readableErrors('UTL', { listErr: gw() })).toEqual([]);
    expect(readableErrors('UTL', { erreur: { listErr: gw() } })).toEqual([]);
    expect(readableErrors('UTL', { retourUtil: { listErr: gw('12') } })).toEqual(gw('12'));
    expect(readableErrors('DOC', { retourDoc: { detail: { listErr: gw() } } })).toEqual([]);
    expect(readableErrors('TRX', { retourTrans: { retourTransActu: { listErr: gw('12') } } })).toEqual(gw('12'));
    expect(readableErrors('TRX', { retourTrans: { listErr: gw('95'), retourTransLot: [{ listErr: gw('12') }, {}] } })).toEqual([...gw('95'), ...gw('12')]);
    expect(readableErrors('TRX', { retourTrans: { listErr: 'not a list' } })).toEqual([]);
    expect(readableErrors('CRT', '<html/>')).toEqual([]);
  });
});

describe('a 4xx with a listErr outside the retour* envelope is REJECTED, never accepted', () => {
  it.each([
    ['top-level listErr', 400, { listErr: gw() }],
    ['foreign wrapper', 403, { erreur: { listErr: gw() } }],
    ['nested deep in another key', 400, { a: { b: [{ listErr: gw() }] } }],
    ['envelope listErr not a list', 400, { retourTrans: { listErr: 'erreur' } }],
  ])('TRX %s (HTTP %s) → codRetour HTTP, logged as a failure', async (_label, status, data) => {
    const h = harness(status, data);
    const [r] = await h.svc.sendTransactions(op, h.material, trans(1));
    expect(r.listErr).toEqual([httpRejection(status)]);
    expect(classifyErrors(r.listErr)).toBe('rejected');
    expect(r.psiNoTrans).toBeUndefined();
    expect(h.logs[0]).toMatchObject({ httpStatus: status, mevErrorCode: 'HTTP', success: false });
  });

  it('UTL, CRT and DOC: the error lands in the envelope each caller reads', async () => {
    const utl = harness(400, { listErr: gw() });
    expect(classifyErrors((await utl.svc.userRequest(op, utl.material, 'AJO', 'staff')).retourUtil.listErr)).toBe('rejected');
    const crt = harness(400, { erreur: { listErr: gw() } });
    expect(classifyErrors((await crt.svc.certificateRequest(op, 'XXXX-XXXX', 'AJO', 'csr')).retourCertif.listErr)).toBe('rejected');
    const doc = harness(400, { listErr: gw() });
    const res = await doc.svc.documentRequest(op, doc.material, reqDoc);
    expect(res.retourDoc.listErr).toEqual([httpRejection(400)]);
    expect(classifyErrors(res.retourDoc.listErr)).toBe('rejected');
    expect(doc.logs[0]).toMatchObject({ httpStatus: 400, mevErrorCode: 'HTTP', success: false });
  });

  it('the body outside the envelope is kept as it came (visible in the answer and in the request log)', async () => {
    const h = harness(400, { listErr: gw() });
    const res: any = await h.svc.userRequest(op, h.material, 'AJO', 'staff');
    expect(res.listErr).toEqual(gw());
  });

  it('a 4xx whose envelope carries its own errors keeps them and their class (unchanged)', async () => {
    const h = harness(400, { retourUtil: { listErr: gw('95') }, listErr: gw() });
    const res = await h.svc.userRequest(op, h.material, 'AJO', 'staff');
    expect(res.retourUtil.listErr).toEqual(gw('95'));
    expect(classifyErrors(res.retourUtil.listErr)).toBe('retry_batch');
    expect(h.logs[0]).toMatchObject({ mevErrorCode: '95', success: false });
  });

  it('a 2xx keeps the envelope as the answer: a listErr outside it changes nothing', async () => {
    const h = harness(200, { retourTrans: { retourTransActu: { noTrans: '1', psiNoTrans: 'SIM1' } }, listErr: gw() });
    const [r] = await h.svc.sendTransactions(op, h.material, trans(1));
    expect(classifyErrors(r.listErr)).toBe('accepted');
    expect(r.psiNoTrans).toBe('SIM1');
    expect(h.logs[0]).toMatchObject({ httpStatus: 200, mevErrorCode: null, success: true });
  });
});

describe('a 4xx batch answer leaves no transaction "accepted"', () => {
  it('the transaction with real errors keeps them; the one without gets codRetour HTTP', async () => {
    const h = harness(400, { retourTrans: { retourTransLot: [{ noTrans: '1', listErr: gw('12') }, { noTrans: '2' }] } });
    const [a, b] = await h.svc.sendTransactions(op, h.material, trans(2));
    expect(a.listErr).toEqual(gw('12'));
    expect(b.listErr).toEqual([httpRejection(400)]);
    expect([a, b].map((r) => classifyErrors(r.listErr))).toEqual(['rejected', 'rejected']);
  });

  it('a "not sent" (95) item stays retry_batch; an item missing from the answer is rejected', async () => {
    const h = harness(400, { retourTrans: { retourTransLot: [{ noTrans: '1', listErr: gw('95') }] } });
    const [a, b] = await h.svc.sendTransactions(op, h.material, trans(2));
    expect(classifyErrors(a.listErr)).toBe('retry_batch');
    expect(b.listErr).toEqual([httpRejection(400)]);
  });

  it('a 2xx batch answer is unchanged: an item without errors is accepted', async () => {
    const h = harness(200, { retourTrans: { retourTransLot: [{ noTrans: '1', listErr: gw('12') }, { noTrans: '2', psiNoTrans: 'SIM2' }] } });
    const [a, b] = await h.svc.sendTransactions(op, h.material, trans(2));
    expect(classifyErrors(a.listErr)).toBe('rejected');
    expect(classifyErrors(b.listErr)).toBe('accepted');
  });
});

describe('end to end, real services over a stubbed HTTP layer', () => {
  const identity = { noTPS: op.noTPS, noTVQ: op.noTVQ };
  const draft: any = {
    documentKind: 'RECEIPT', typTrans: 'RFER', modImpr: 'FAC', formImpr: 'PAP', modTrans: 'OPE', typServ: 'CMP', ecommerce: false, modPai: 'ARG',
    lines: [{ description: 'Poutine', quantity: '1', unitPriceCents: 1299, totalCents: 1299, tax: 'FP', activity: 'RES' }],
  };
  const keys = generateP256();

  function submitHarness(status: number, data: unknown) {
    const { core, signedString } = buildTransCore(draft, { noTrans: '7', datTrans: '20261024120000', utc: '-04:00', datActu: '20261024120000', nomUtil: 'staff', preced: FIRST_PRECED }, identity);
    const stored = { ...core, signa: { actu: signP256(keys.privateKeyPem, signedString), preced: FIRST_PRECED, datActu: core.datTrans } };
    const writes: Array<{ what: string; data: any }> = [];
    const rec = (what: string) => async (a: { data?: any }) => (writes.push({ what, data: a.data }), {});
    const prisma: any = {
      offlineQueue: { findMany: async () => [{ id: 'q1', transactionId: 'tx1', transaction: { id: 'tx1', deviceSeq: 1, noTrans: '7', requestJson: stored } }], updateMany: async () => ({}), update: rec('queue') },
      device: { findUniqueOrThrow: async () => ({ id: 'dev', serialNumber: 'S', fileNumber: 'ER0000', offlineMode: false, operator: { id: 'op', ...identity } }), update: rec('device') },
      transaction: { update: rec('tx'), updateMany: rec('txMany') },
      $transaction: async (ops: Promise<unknown>[]) => Promise.all(ops),
      mevRequestLog: { create: async () => ({ id: 'l1' }), update: async () => ({}) },
    };
    const certificates: any = { signingMaterial: async () => ({ expired: false, sign: softwareSigner(keys.privateKeyPem).sign, certPem: '', thumbprint: 't', mevDeviceId: 'd' }) };
    const audits: any[] = [];
    const audit: any = { log: async (a: any) => void audits.push(a) };
    const mevWeb = new MevWebService(cfg, { post: () => of({ status, data }) } as any, prisma);
    const svc = new TransactionsService(cfg, prisma, certificates, mevWeb, audit);
    return { submit: () => (svc as any).submitBatch('dev'), writes, audits };
  }

  it('TransactionsService: a 4xx with a top-level listErr → REJECTED, queue FAILED, MEV_ERROR audit; nothing ACCEPTED', async () => {
    const h = submitHarness(400, { listErr: gw() });
    expect(await h.submit()).toMatchObject({ sent: 1, accepted: 0, settled: 1 });
    expect(h.writes.find((w) => w.what === 'tx')?.data).toMatchObject({ mevStatus: 'REJECTED', mevErrors: [httpRejection(400)] });
    expect(h.writes.find((w) => w.what === 'queue')?.data).toMatchObject({ status: 'FAILED' });
    expect(h.writes.some((w) => w.data?.mevStatus === 'ACCEPTED' || w.data?.status === 'COMPLETED')).toBe(false);
    expect(h.audits.map((a) => `${a.eventType}/${a.severity}`)).toEqual(['MEV_ERROR/ERROR']);
  });

  it('TransactionsService: the same sale is ACCEPTED on a real 2xx answer (control)', async () => {
    const h = submitHarness(200, { retourTrans: { retourTransActu: { noTrans: '7', psiNoTrans: 'SIM-7', psiDatTrans: '20261024120001' } } });
    expect(await h.submit()).toMatchObject({ accepted: 1 });
    expect(h.writes.find((w) => w.what === 'tx')?.data).toMatchObject({ mevStatus: 'ACCEPTED', mevTransactionNumber: 'SIM-7' });
  });

  it('OperatorsService: a UTL 4xx with a {erreur: {listErr}} body never marks the user registered', async () => {
    const updates: any[] = [];
    const audits: any[] = [];
    const prisma: any = {
      sEVUser: { findFirst: async () => ({ id: 'u1', operatorId: 'op', mevUserName: 'staff' }), update: async (a: any) => (updates.push(a), {}) },
      operator: { findUniqueOrThrow: async () => ({ id: 'op', ...identity }) },
      device: { findMany: async () => [{ id: 'dev' }] },
      mevRequestLog: { create: async () => ({ id: 'l1' }), update: async () => ({}) },
    };
    const certificates: any = { signingMaterial: async () => ({ expired: false, sign: softwareSigner(keys.privateKeyPem).sign, certPem: '', thumbprint: 't', mevDeviceId: 'd' }) };
    const mevWeb = new MevWebService(cfg, { post: () => of({ status: 403, data: { erreur: { listErr: gw() } } }) } as any, prisma);
    const ops = new OperatorsService(cfg, prisma, certificates, mevWeb, { log: async (a: any) => void audits.push(a) } as any);
    await expect(ops.registerSevUser('op', 'u1')).rejects.toMatchObject({ response: { status: 'rejected', errors: [httpRejection(403)] } });
    expect(updates).toEqual([]);
    expect(audits.map((a) => a.eventType)).toEqual(['MEV_ERROR']);
  });
});
