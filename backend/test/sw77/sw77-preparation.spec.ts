/**
 * SW-77 PREPARATION SUITE: database integration, against the LOCAL SIMULATOR.
 * ────────────────────────────────────────────────────────────────────────────
 * These are NOT Revenu Québec's SW-77 test cases: SW-77 is personalized and comes with the partner documents, and
 * only Revenu Québec's DEV / ESSAI environments can judge conformity. This suite keeps the core line's SW-77 matrix
 * (SW77-01 … SW77-12) and runs each item on the OFFICIAL layer (names PROVEN / S1 / SPEC, see SPEC_GAPS.md):
 *
 *   SW77-01 CRT AJO (ECDSA P-256 CSR, two certificates, IDAPPRL)      SW77-07 multi-payment → modPai MIX
 *   SW77-02 UTL (users registered after CRT, sync-mev no-op)          SW77-08 signature chain (signa.preced, ECDSA verify)
 *   SW77-03 sale → typTrans RFER / modImpr FAC, MEV number            SW77-09 internal SHA-256 audit chain recomputes
 *   SW77-04 "annulation" → full credit note, refs to the original     SW77-10 tip → mont.pourb, never in apresTax
 *   SW77-05 "correction" → « Facture corrigée » on a credited receipt SW77-11 DOC → user report (RUT), not a Z-report
 *   SW77-06 training → modTrans FOR                                   SW77-12 offline batch (transLot) + write-back
 * plus the core line's other behaviours: public registration, request DTOs, tenant isolation, REJECTED originals,
 * certificate renewal (CRT REM + nightly job), runtime check of stored transactions, official headers in the log;
 * and the round-1 review rules: ASCII request text, the CSR's address UTC (L=-05:00), no invoice and no transmission
 * with an expired certificate (the queue waits for the renewal), the user report's displayed contents and summary.
 *
 * Needs a migrated PostgreSQL (DATABASE_URL) and QCMEV_DB_TESTS=1; tools/local-run runs it on an embedded
 * PostgreSQL 16 (`npm run test:integration`). It boots the whole API in-process, on a free port, in SIMULATOR mode,
 * with its own operators (random NEQ, placeholder identity values) and its own simulator state.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/bootstrap';
import { CertificateLifecycleService } from '../../src/certificates/certificate-lifecycle.service';
import { canonicalJson } from '../../src/common/canonical-json';
import { civilTime } from '../../src/common/time';
import { loadConfig } from '../../src/config/app-config';
import * as x509 from '@peculiar/x509';
import { FIRST_PRECED, GENESIS_HASH, nextHashChain, transactionSignedString, verifyP256 } from '../../src/crypto/ecdsa';
import { KEY_VAULT, KeyVault } from '../../src/crypto/key-vault';
import { PrismaService } from '../../src/prisma/prisma.service';

const RUN = process.env.QCMEV_DB_TESTS === '1' && !!process.env.DATABASE_URL;
const suite = RUN ? describe : describe.skip;
jest.setTimeout(120_000);

const PLACEHOLDER = { noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001', file: 'ER0000', auth: 'XXXX-XXXX' };
const hex = (n: number) => crypto.randomBytes(n).toString('hex');
const randomNeq = () => String(1_000_000_000 + crypto.randomInt(0, 999_999_999)).slice(0, 10);

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

/* eslint-disable @typescript-eslint/no-explicit-any */
suite('SW-77 preparation suite (database + local simulator; not Revenu Québec SW-77)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let base = '';
  let stateDir = '';
  const results: Array<{ id: string; status: 'PASS' | 'FAIL' }> = [];
  let tokenA = '';
  let tokenB = '';
  let deviceA = '';
  let deviceA2 = '';
  let deviceB = '';
  let operatorA = '';
  const adminA = { username: `sw77-admin-${hex(3)}`, password: `Adm-${hex(10)}` };
  const adminB = { username: `sw77-adminb-${hex(3)}`, password: `Adm-${hex(10)}` };
  const neqA = randomNeq();

  async function api(method: string, p: string, body?: unknown, token = tokenA): Promise<{ status: number; body: any }> {
    const r = await fetch(`${base}/api${p}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : null };
  }
  async function ok(method: string, p: string, body?: unknown, token = tokenA): Promise<any> {
    const r = await api(method, p, body, token);
    if (r.status >= 300) throw new Error(`${method} ${p} → ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`);
    return r.body;
  }
  const item = (description: string, unitPriceCents: number, tax = 'FP', quantity = '1') => ({ description, quantity, unitPriceCents, tax });
  const sale = (deviceId: string, items: unknown[], paymentMode = 'ARG', extra: Record<string, unknown> = {}) => ok('POST', '/transactions', { deviceId, items, paymentMode, serviceType: 'CMP', ...extra });
  const track = (id: string) => (fn: () => Promise<void>) => async () => {
    try {
      await fn();
      results.push({ id, status: 'PASS' });
    } catch (e) {
      results.push({ id, status: 'FAIL' });
      throw e;
    }
  };

  beforeAll(async () => {
    const port = await freePort();
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcmev-sw77-'));
    const cfg = loadConfig({
      ...process.env,
      PORT: String(port),
      MEV_ENVIRONMENT: 'SIMULATOR',
      SIMULATOR_URL: '',
      MEV_QR_BASE_URL: '',
      MEV_SIMULATOR_STATE_DIR: stateDir,
      MEV_OFFLINE_FLUSH_SECONDS: '0',
      QCMEV_FOODHUB_ENABLED: 'false',
      QCMEV_PUBLIC_REGISTRATION: 'true',
      QCMEV_RATE_LIMIT_PER_SECOND: '1000',
      QCMEV_RATE_LIMIT_PER_MINUTE: '100000',
      JWT_SECRET: process.env.JWT_SECRET || hex(32),
      PRIVATE_KEY_ENCRYPTION_KEY: process.env.PRIVATE_KEY_ENCRYPTION_KEY || hex(32),
      LOG_LEVEL: 'warn',
    });
    app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(cfg), { rawBody: true, logger: ['error'] });
    configureApp(app, cfg);
    await app.listen(port, '127.0.0.1');
    prisma = app.get(PrismaService);
    base = `http://127.0.0.1:${port}`;

    // Public registration (core line): 201, then 400 on a bad body, 409 on a duplicate NEQ, 400 for another environment.
    // (5 calls: the route allows 5 a minute per IP; a duplicate username is checked on POST /operators/users below.)
    const reg = { name: 'Restaurant SW-77 (données fictives)', neq: neqA, noTPS: PLACEHOLDER.noTPS, noTVQ: PLACEHOLDER.noTVQ, adminUsername: adminA.username, adminPassword: adminA.password, adminFirstName: 'Admin', adminLastName: 'Essai' };
    const r1 = await api('POST', '/operators/register', reg, '');
    expect(r1.status).toBe(201);
    operatorA = r1.body.operatorId;
    expect(JSON.stringify(r1.body)).not.toContain(PLACEHOLDER.noTPS);
    const bad = await api('POST', '/operators/register', { ...reg, neq: '12', adminPassword: 'short', sector: 'RST' }, '');
    expect(bad.status).toBe(400);
    expect(JSON.stringify(bad.body.message)).toMatch(/neq/);
    expect((await api('POST', '/operators/register', { ...reg, adminUsername: `${adminA.username}-2` }, '')).status).toBe(409);
    expect((await api('POST', '/operators/register', { ...reg, neq: randomNeq(), adminUsername: `x-${hex(3)}`, environment: 'ESSAI' }, '')).status).toBe(400);

    tokenA = (await ok('POST', '/auth/login', adminA, '')).accessToken;
    const dA = await ok('POST', '/devices', { serialNumber: `SW77-A-${hex(3)}`, name: 'Caisse 1', model: 'Modèle test', firmwareVersion: '1.0.0', fileNumber: PLACEHOLDER.file, authorizationCode: PLACEHOLDER.auth });
    deviceA = dA.id;
    expect(dA).toMatchObject({ name: 'Caisse 1', model: 'Modèle test', firmwareVersion: '1.0.0', hasFileNumber: true, hasAuthorizationCode: true, certified: false });
    expect(JSON.stringify(dA)).not.toMatch(new RegExp(`${PLACEHOLDER.file}|${PLACEHOLDER.auth}`));
    deviceA2 = (await ok('POST', '/devices', { serialNumber: `SW77-A2-${hex(3)}`, fileNumber: PLACEHOLDER.file, authorizationCode: PLACEHOLDER.auth })).id;
    expect((await api('POST', '/devices', { serialNumber: '', deviceType: 'POS' })).status).toBe(400);

    // A cashier created before any certificate: not registered with UTL yet.
    const cashier = await ok('POST', '/operators/users', { username: `sw77-cashier-${hex(3)}`, password: `Csh-${hex(10)}`, firstName: 'Jean', lastName: 'Tremblay', role: 'CASHIER' });
    expect(cashier.registration.status).toBe('not_registered');
    expect(JSON.stringify(cashier)).not.toContain('passwordHash');
    expect((await api('POST', '/operators/users', { username: adminA.username, password: `Dup-${hex(10)}`, firstName: 'Dup' })).status).toBe(409);

    // Operator B (tenant isolation checks).
    expect((await api('POST', '/operators/register', { ...reg, neq: randomNeq(), adminUsername: adminB.username, adminPassword: adminB.password }, '')).status).toBe(201);
    tokenB = (await ok('POST', '/auth/login', adminB, '')).accessToken;
    deviceB = (await ok('POST', '/devices', { serialNumber: `SW77-B-${hex(3)}`, fileNumber: PLACEHOLDER.file, authorizationCode: PLACEHOLDER.auth }, tokenB)).id;
  });

  afterAll(async () => {
    // eslint-disable-next-line no-console
    console.log(`SW-77 preparation suite: ${results.filter((r) => r.status === 'PASS').length}/${results.length} passed\n${results.map((r) => `  ${r.status}  ${r.id}`).join('\n')}\n(internal checks against our own simulator, not Revenu Québec's SW-77 cases)`);
    await app?.close();
    if (stateDir) fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('SW77-01 CRT AJO: ECDSA P-256 CSR, SEV + MEV-WEB certificates, IDAPPRL; the users are registered at once', track('SW77-01')(async () => {
    const c = await ok('POST', `/devices/${deviceA}/certificate`, {});
    expect(c).toMatchObject({ status: 'issued', modif: 'AJO', reason: 'MANUAL', usersFailed: 0 });
    expect(c.usersRegistered).toBeGreaterThanOrEqual(2); // admin + cashier
    expect(c.mevDeviceId).toMatch(/^SIM/);
    const certs = await ok('GET', '/certificates');
    expect(certs.filter((x: any) => x.deviceId === deviceA && x.isActive).map((x: any) => x.type).sort()).toEqual(['MEV_WEB', 'SEV']);
    const sev = await prisma.certificate.findFirstOrThrow({ where: { deviceId: deviceA, type: 'SEV', isActive: true } });
    const pub = new crypto.X509Certificate(sev.pemCertificate as string).publicKey;
    expect(pub.asymmetricKeyType).toBe('ec');
    expect(pub.asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
    // L= is the fixed UTC of the business address (-05:00 for Montréal), even while daylight saving is -04:00.
    const csrPem = app.get<KeyVault>(KEY_VAULT).decrypt(sev.csrPem as string, `csr:${deviceA}`);
    expect(new x509.Pkcs10CertificateRequest(csrPem).subjectName.getField('L')).toEqual(['-05:00']);
    expect((await api('PUT', `/devices/${deviceA}`, { fileNumber: 'ER9999' })).status).toBe(409); // frozen once certified
  }));

  it('SW77-02 UTL: every user registered (nomUtil), sync-mev is then a no-op, a new user is registered at creation', track('SW77-02')(async () => {
    const users = await ok('GET', '/operators/users');
    expect(users.every((u: any) => u.mevRegisteredAt && u.mevUserName)).toBe(true);
    expect(await ok('POST', '/operators/users/sync-mev', {})).toEqual({ registered: [], failed: [] });
    const later = await ok('POST', '/operators/users', { username: `sw77-mgr-${hex(3)}`, password: `Mgr-${hex(10)}`, firstName: 'Marie', role: 'MANAGER' });
    expect(later.registration).toMatchObject({ status: 'registered', modif: 'AJO', devices: 1 });
  }));

  let firstSale: any;
  it('SW77-03 sale: RFER / FAC, Montréal civil time, accepted with a MEV number', track('SW77-03')(async () => {
    firstSale = await sale(deviceA, [item('Café americano', 350, 'FP', '2')]);
    expect(firstSale).toMatchObject({ transactionType: 'RFER', printMode: 'FAC', documentKind: 'RECEIPT', mevStatus: 'ACCEPTED', subtotalCents: 700 });
    expect(firstSale.mevTransactionNumber).toMatch(/^SIM/);
    expect(firstSale.civilDate).toBe(civilTime().civilDate);
    expect(firstSale.receipt.mentions).toContain('PAIEMENT REÇU');
    expect((await api('POST', '/transactions', { deviceId: deviceA, items: [{ description: 'x', unitPriceCents: 1.5 }], paymentMode: 'CASH' })).status).toBe(400);
  }));

  it('SW77-04 cancellation = full credit note: negative amounts, refs to the original noTrans / datTrans / avantTax', track('SW77-04')(async () => {
    const cn = await ok('POST', `/transactions/${firstSale.id}/cancel`, { reason: 'SW77-04' });
    expect(cn).toMatchObject({ transactionType: 'RFER', documentKind: 'CREDIT_NOTE', subtotalCents: -700, relatedTransactionId: firstSale.id, mevStatus: 'ACCEPTED' });
    expect(cn.requestJson.refs).toEqual([{ noTrans: firstSale.noTrans, datTrans: firstSale.datTrans, avantTax: '7.00' }]);
    expect((await ok('GET', `/transactions/${firstSale.id}`)).status).toBe('CREDITED');
    expect((await api('POST', `/transactions/${firstSale.id}/cancel`, {})).status).toBe(400);
    expect((await api('POST', `/transactions/${cn.id}/credit-note`, { full: true })).status).toBe(400);
  }));

  it('SW77-05 correction = « Facture corrigée »: a new receipt referencing the credited one', track('SW77-05')(async () => {
    const fixed = await sale(deviceA, [item('Café americano', 325, 'FP', '2')], 'ARG', { relatedTransactionId: firstSale.id });
    expect(fixed.relatedTransactionId).toBe(firstSale.id);
    expect(fixed.receipt.mentions).toContain('Facture corrigée');
    const other = await sale(deviceA, [item('Sandwich', 875)]);
    expect((await api('POST', '/transactions', { deviceId: deviceA, items: [item('x', 100)], paymentMode: 'ARG', relatedTransactionId: other.id })).status).toBe(400);
  }));

  it('SW77-06 training mode: modTrans FOR, transmitted', track('SW77-06')(async () => {
    const t = await sale(deviceA, [item('Produit formation', 1000)], 'CRE', { training: true });
    expect(t).toMatchObject({ transactionMode: 'FOR', mevStatus: 'ACCEPTED' });
    expect(t.receipt.mentions).toContain('***DOCUMENT DE FORMATION***');
  }));

  it('SW77-07 multi-payment: modPai MIX', track('SW77-07')(async () => {
    expect(await sale(deviceA, [item('Repas complet', 2500)], 'MIX')).toMatchObject({ paymentMode: 'MIX', mevStatus: 'ACCEPTED' });
  }));

  it('SW77-10 tip: mont.pourb, never inside apresTax', track('SW77-10')(async () => {
    const t = await sale(deviceA, [item('Dîner', 4000)], 'CRE', { tipCents: 500 });
    expect(t.requestJson.mont.pourb).toBe('5.00');
    expect(t.totalCents).toBe(t.subtotalCents + t.tpsCents + t.tvqCents);
  }));

  it('SW77-11 DOC: the user report (RUT) is displayed with the listed contents and its full summary is transmitted', track('SW77-11')(async () => {
    const r = await ok('POST', '/reports/user-report', { year: Number(civilTime().civilDate.slice(0, 4)), deviceId: deviceA });
    expect(r).toMatchObject({ mevStatus: 'ACCEPTED', transmitted: true });
    expect(r.mevReportNumber).toMatch(/^SIMDOC/);
    const text = (r.display.lines as string[]).join('\n').replace(/\n {2}/g, ' ');
    const device = await prisma.device.findUniqueOrThrow({ where: { id: deviceA } });
    const last = await prisma.transaction.findFirstOrThrow({ where: { deviceId: deviceA }, orderBy: { deviceSeq: 'desc' } });
    for (const s of ["RAPPORT DE L'UTILISATEUR", 'Restaurant SW-77 (données fictives)', `No TPS : ${PLACEHOLDER.noTPS}`, `No TVQ : ${PLACEHOLDER.noTVQ}`, 'Utilisateur : Admin Essai', `No de transaction : ${last.noTrans}`, "Identifiant de l'appareil : " + device.mevDeviceId, 'Identifiant du SEV', 'Version du SEV', 'Connexion au compte : ', 'Rapport produit le : ', '[CODE QR]']) {
      expect(text).toContain(s);
    }
    expect(text).not.toMatch(/avantTax|apresTax|Sommaire/); // the sales summary is transmitted, never displayed
    expect(r.display.qr.pngDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(r.summary).toBeUndefined();
    const doc = await prisma.mevRequestLog.findFirstOrThrow({ where: { operatorId: operatorA, requestType: 'DOC' }, orderBy: { createdAt: 'desc' } });
    const sv = (doc.requestPayload as any).body.reqDoc.sommVentes;
    // (the log is JSONB, which reorders keys: compare the set)
    expect(Object.keys(sv).sort()).toEqual(['nbTrans', 'nbTransPai', 'avantTax', 'TPS', 'TVQ', 'apresTax', 'ajus', 'mtdu'].sort());
    expect(sv.nbTrans).toBeGreaterThanOrEqual(sv.nbTransPai);
    expect(sv.mtdu).toBe(sv.apresTax); // no adjustment recorded
  }));

  it('ASCII: a sale with accented items and an accented user name reaches the simulator as ASCII text', track('ASCII')(async () => {
    const t = await sale(deviceA, [item('Poutine régulière', 1299), item('Crème brûlée', 650)]);
    expect(t.mevStatus).toBe('ACCEPTED');
    expect(t.items.map((i: any) => i.description)).toEqual(['Poutine régulière', 'Crème brûlée']);
    // The simulator refuses any request that is not ASCII text (SIM-ASCII), so the acceptance above proves it.
    const log = await prisma.mevRequestLog.findFirstOrThrow({ where: { operatorId: operatorA, requestType: 'TRX', success: true }, orderBy: { createdAt: 'desc' } });
    expect((log.requestPayload as any).body.reqTrans.transActu.items[0].descr).toBe('Poutine régulière');
  }));

  it('SW77-12 offline: signed locally and queued, credit note of a queued sale queued behind it, batch, write-back, back online', track('SW77-12')(async () => {
    await ok('POST', '/mev-simulator/_control', { mevDown: true }, '');
    let a: any;
    let b: any;
    let cn: any;
    try {
      a = await sale(deviceA, [item('Hors ligne A', 1000)]);
      b = await sale(deviceA, [item('Hors ligne B', 1100)]);
      expect([a.mevStatus, b.mevStatus]).toEqual(['OFFLINE_PENDING', 'OFFLINE_PENDING']);
      expect(a.receipt.mentions).toContain('PROBLÈME DE COMMUNICATION');
      const st = await ok('GET', `/devices/${deviceA}/offline-status`);
      expect(st.offlineMode).toBe(true);
      expect(st.offlineSince).toBeTruthy();
      expect(st.pendingCount).toBe(2);
      // The original still waits for MEV-WEB: its reference is its own noTrans / datTrans, so the credit note is signed now.
      cn = await ok('POST', `/transactions/${a.id}/credit-note`, { full: true, reason: 'queued original' });
      expect(cn.mevStatus).toBe('OFFLINE_PENDING');
      expect(cn.requestJson.refs[0]).toMatchObject({ noTrans: a.noTrans, datTrans: a.datTrans });
    } finally {
      await ok('POST', '/mev-simulator/_control', { mevDown: false }, '');
    }
    const flush = await ok('POST', `/devices/${deviceA}/flush-queue`, {});
    expect(flush).toMatchObject({ accepted: 3, pendingCount: 0, offlineMode: false, offlineSince: null });
    for (const t of [a, b, cn]) {
      const now = await ok('GET', `/transactions/${t.id}`);
      expect(now).toMatchObject({ mevStatus: 'ACCEPTED', noTrans: t.noTrans });
      expect(now.mevTransactionNumber).toMatch(/^SIM/);
    }
    expect((await ok('GET', `/transactions/${a.id}`)).status).toBe('CREDITED'); // the flush never resets the status
    const events = await prisma.auditLog.findMany({ where: { deviceId: deviceA, eventType: { in: ['OFFLINE_MODE_ACTIVATED', 'BATCH_SUBMITTED', 'OFFLINE_MODE_DEACTIVATED'] } }, orderBy: { createdAt: 'asc' } });
    expect(events.map((e) => e.eventType)).toEqual(['OFFLINE_MODE_ACTIVATED', 'BATCH_SUBMITTED', 'OFFLINE_MODE_DEACTIVATED']);
  }));

  it('official request headers in the (redacted) MEV request log; none of the old invented names', track('HEADERS')(async () => {
    const log = await prisma.mevRequestLog.findFirstOrThrow({ where: { operatorId: operatorA, requestType: 'TRX', success: true }, orderBy: { createdAt: 'desc' } });
    const p = log.requestPayload as any;
    expect(p.headers).toMatchObject({ ENVIRN: 'DEV', APPRLINIT: 'SEV' });
    for (const h of ['IDSEV', 'IDVERSI', 'CODCERTIF', 'IDPARTN', 'VERSI', 'VERSIPARN', 'IDAPPRL', 'EMPRCERTIFTRANSM']) expect(p.headers[h]).toBeTruthy();
    expect(p.headers.SIGNATRANSM).toHaveLength(88);
    const t = p.body.reqTrans.transActu ?? p.body.reqTrans.transLot[0];
    expect(t.noTPS).toBe('[REDACTED]');
    expect(t.noDossFO).toBe('[REDACTED]');
    expect(JSON.stringify(p)).not.toMatch(/typeRequete|entete|corps|codeAutorisation|numeroTransaction/);
  }));

  it('SW77-08 signature chain: each preced is the previous signature and every signature verifies with the device certificate', track('SW77-08')(async () => {
    const txs = await prisma.transaction.findMany({ where: { deviceId: deviceA }, orderBy: { deviceSeq: 'asc' } });
    const certs = await prisma.certificate.findMany({ where: { deviceId: deviceA, type: 'SEV' } });
    expect(txs[0].previousSignature).toBe(FIRST_PRECED);
    txs.forEach((t, i) => {
      if (i > 0) expect(t.previousSignature).toBe(txs[i - 1].signature);
      const j = t.requestJson as any;
      const signedString = transactionSignedString({ noTrans: j.noTrans, datTrans: j.datTrans, TPS: j.mont.TPS, TVQ: j.mont.TVQ, apresTax: j.mont.apresTax, noTPS: PLACEHOLDER.noTPS, noTVQ: PLACEHOLDER.noTVQ, modImpr: j.modImpr, modTrans: j.modTrans, preced: j.signa.preced });
      expect(certs.some((c) => verifyP256(c.pemCertificate as string, signedString, t.signature))).toBe(true);
    });
  }));

  it('SW77-09 internal SHA-256 audit chain recomputes from the stored transactions', track('SW77-09')(async () => {
    const txs = await prisma.transaction.findMany({ where: { deviceId: deviceA }, orderBy: { deviceSeq: 'asc' } });
    let prev = GENESIS_HASH;
    for (const t of txs) {
      prev = nextHashChain(prev, canonicalJson(t.requestJson));
      expect(t.hashChain).toBe(prev);
    }
  }));

  it('tenant isolation: operator B gets 404 on every route of operator A', track('TENANT')(async () => {
    const tx = await sale(deviceA, [item('Item A', 2000), item('Item B', 1000)]);
    const other = await sale(deviceA, [item('Autre', 500)]);
    for (const [m, p] of [
      ['GET', `/transactions/${tx.id}`],
      ['GET', `/transactions/${tx.id}/receipt`],
      ['GET', `/transactions/${tx.id}/receipt/text`],
      ['POST', `/transactions/${tx.id}/credit-note`],
      ['POST', `/transactions/${tx.id}/cancel`],
      ['POST', `/transactions/${tx.id}/reprint`],
      ['POST', `/transactions/${tx.id}/items/${tx.items[0].id}/remove`],
      ['POST', `/transactions/${tx.id}/items/${tx.items[0].id}/price`],
      ['GET', `/devices/${deviceA}`],
      ['PUT', `/devices/${deviceA}`],
      ['GET', `/devices/${deviceA}/offline-status`],
      ['POST', `/devices/${deviceA}/flush-queue`],
      ['POST', `/devices/${deviceA}/certificate`],
    ] as const) {
      const body = m === 'GET' ? undefined : p.endsWith('/price') ? { newUnitPriceCents: 1 } : m === 'PUT' ? { name: 'x' } : {};
      expect([m, p, (await api(m, p, body, tokenB)).status]).toEqual([m, p, 404]);
    }
    expect(await ok('GET', `/transactions/${tx.id}/modifications`, undefined, tokenB)).toEqual([]);
    expect([404, 423]).toContain((await api('POST', '/transactions', { deviceId: deviceA, items: [item('x', 100)], paymentMode: 'ARG' }, tokenB)).status);
    // An item must belong to the transaction named in the route.
    expect((await api('POST', `/transactions/${tx.id}/items/${other.items[0].id}/remove`, {})).status).toBe(404);
    expect((await ok('GET', `/transactions/${tx.id}/receipt/text`)).text).toContain(tx.noTrans);
  }));

  it('an original REJECTED by MEV-WEB cannot be referenced (credit note, reprint, post-invoice change)', track('REJECTED')(async () => {
    const tx = await sale(deviceA, [item('Rejetée', 1500)]);
    await prisma.transaction.update({ where: { id: tx.id }, data: { mevStatus: 'REJECTED' } });
    expect((await api('POST', `/transactions/${tx.id}/credit-note`, { full: true })).status).toBe(400);
    expect((await api('POST', `/transactions/${tx.id}/reprint`, { mode: 'RPR' })).status).toBe(400);
    expect((await api('POST', `/transactions/${tx.id}/items`, item('ajout', 100))).status).toBe(400);
    await prisma.transaction.update({ where: { id: tx.id }, data: { mevStatus: 'ACCEPTED' } });
  }));

  it('certificate renewal: CRT REM keeps the IDAPPRL and the chain; the nightly job picks expiring certificates and audits failures', track('RENEWAL')(async () => {
    const before = await prisma.device.findUniqueOrThrow({ where: { id: deviceA } });
    const oldCert = await prisma.certificate.findFirstOrThrow({ where: { deviceId: deviceA, type: 'SEV', isActive: true } });
    const run = await ok('POST', '/certificates/renew', { deviceId: deviceA });
    expect(run.failed).toEqual([]);
    expect(run.renewed).toHaveLength(1);
    const after = await prisma.device.findUniqueOrThrow({ where: { id: deviceA } });
    expect(after.mevDeviceId).toBe(before.mevDeviceId);
    const newCert = await prisma.certificate.findFirstOrThrow({ where: { deviceId: deviceA, type: 'SEV', isActive: true } });
    expect(newCert.serialNumber).not.toBe(oldCert.serialNumber);
    expect(await sale(deviceA, [item('Après renouvellement', 900)])).toMatchObject({ mevStatus: 'ACCEPTED' });

    // Nightly job: a certificate inside the window is renewed; a device that cannot renew is audited (CRITICAL: expired).
    await prisma.certificate.update({ where: { id: newCert.id }, data: { validUntil: new Date(Date.now() + 5 * 86400_000) } });
    const broken = await prisma.device.create({ data: { operatorId: operatorA, serialNumber: `SW77-BROKEN-${hex(3)}` } });
    await prisma.certificate.create({ data: { operatorId: operatorA, deviceId: broken.id, type: 'SEV', serialNumber: 'BROKEN', validUntil: new Date(Date.now() - 86400_000), isActive: true } });
    const job = await app.get(CertificateLifecycleService).renewExpiringCertificates();
    expect(job.renewed.map((r) => r.deviceId)).toContain(deviceA);
    expect(job.failed.map((f) => f.deviceId)).toContain(broken.id);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { deviceId: broken.id, eventType: 'MEV_ERROR' } });
    expect(audit.severity).toBe('CRITICAL');
    await prisma.certificate.updateMany({ where: { deviceId: broken.id }, data: { isActive: false } });
    await prisma.device.update({ where: { id: broken.id }, data: { isActive: false } });
    expect(await sale(deviceA, [item('Après le job', 800)])).toMatchObject({ mevStatus: 'ACCEPTED' });
  }));

  it('expired certificate: no invoice (423 certReady), nothing transmitted, the queue waits for the renewal', track('EXPIRED')(async () => {
    await ok('POST', '/mev-simulator/_control', { mevDown: true }, '');
    let queued: any;
    try {
      queued = await sale(deviceA, [item('Avant expiration', 700)]);
      expect(queued.mevStatus).toBe('OFFLINE_PENDING');
    } finally {
      await ok('POST', '/mev-simulator/_control', { mevDown: false }, '');
    }
    const cert = await prisma.certificate.findFirstOrThrow({ where: { deviceId: deviceA, type: 'SEV', isActive: true } });
    await prisma.certificate.update({ where: { id: cert.id }, data: { validUntil: new Date(Date.now() - 60_000) } });
    try {
      const sentBefore = await prisma.mevRequestLog.count({ where: { operatorId: operatorA, requestType: { in: ['TRX', 'DOC'] } } });
      const txBefore = await prisma.transaction.count({ where: { deviceId: deviceA } });
      const refused = await api('POST', '/transactions', { deviceId: deviceA, items: [item('Après expiration', 500)], paymentMode: 'ARG', serviceType: 'CMP' });
      expect(refused.status).toBe(423);
      expect(refused.body).toMatchObject({ error: 'location_not_ready', field: 'certReady' });
      expect(await prisma.transaction.count({ where: { deviceId: deviceA } })).toBe(txBefore); // nothing signed or stored
      expect((await api('POST', `/transactions/${queued.id}/reprint`, { mode: 'RPR' })).status).toBe(423); // a reprint is an invoice too
      const held = await ok('POST', `/devices/${deviceA}/flush-queue`, {});
      expect(held).toMatchObject({ sent: 0, pendingCount: 1 });
      const rep = await ok('POST', '/reports/user-report', { year: Number(civilTime().civilDate.slice(0, 4)), deviceId: deviceA });
      expect(rep).toMatchObject({ transmitted: false, notTransmittedReason: 'certificateExpired' });
      expect(rep.display.lines.length).toBeGreaterThan(10); // still displayed
      expect(await prisma.mevRequestLog.count({ where: { operatorId: operatorA, requestType: { in: ['TRX', 'DOC'] } } })).toBe(sentBefore);
    } finally {
      await prisma.certificate.update({ where: { id: cert.id }, data: { validUntil: cert.validUntil } });
    }
    const flush = await ok('POST', `/devices/${deviceA}/flush-queue`, {});
    expect(flush).toMatchObject({ accepted: 1, pendingCount: 0, offlineMode: false });
    expect((await ok('GET', `/transactions/${queued.id}`)).mevStatus).toBe('ACCEPTED');
  }));

  it('a stored transaction that fails the runtime check is never sent: REJECTED, queue FAILED, CRITICAL audit', track('PAYLOAD')(async () => {
    await ok('POST', `/devices/${deviceA2}/certificate`, {});
    await ok('POST', '/mev-simulator/_control', { mevDown: true }, '');
    let tx: any;
    try {
      tx = await sale(deviceA2, [item('Altérée', 1200)]);
      expect(tx.mevStatus).toBe('OFFLINE_PENDING');
    } finally {
      await ok('POST', '/mev-simulator/_control', { mevDown: false }, '');
    }
    const stored = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    await prisma.transaction.update({ where: { id: tx.id }, data: { requestJson: { ...(stored.requestJson as object), modPai: 'CARTE' } } });
    const flush = await ok('POST', `/devices/${deviceA2}/flush-queue`, {});
    expect(flush.pendingCount).toBe(0);
    expect((await ok('GET', `/transactions/${tx.id}`)).mevStatus).toBe('REJECTED');
    expect((await prisma.offlineQueue.findFirstOrThrow({ where: { transactionId: tx.id } })).status).toBe('FAILED');
    expect((await prisma.auditLog.findFirstOrThrow({ where: { entityId: tx.id, eventType: 'MEV_ERROR' } })).severity).toBe('CRITICAL');
    // No request with the tampered transaction ever reached MEV-WEB.
    const sentModPai = (await prisma.mevRequestLog.findMany({ where: { operatorId: operatorA, requestType: 'TRX' } })).map((l) => JSON.stringify(l.requestPayload));
    expect(sentModPai.some((s) => s.includes('"CARTE"'))).toBe(false);
    // Put the stored record back (it stays REJECTED) so that database-wide audits of the chain still recompute.
    await prisma.transaction.update({ where: { id: tx.id }, data: { requestJson: stored.requestJson as object } });
  }));

  it('operator B is untouched and can certify its own device', track('TENANT-B')(async () => {
    expect((await ok('GET', '/transactions', undefined, tokenB))).toEqual([]);
    const c = await ok('POST', `/devices/${deviceB}/certificate`, {}, tokenB);
    expect(c.status).toBe('issued');
    expect(await sale(deviceB, [item('Vente B', 1000)]).catch((e) => String(e))).toMatch(/404|423/); // tokenA cannot use B's device
  }));
});
