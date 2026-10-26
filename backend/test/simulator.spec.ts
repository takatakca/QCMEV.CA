import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config/app-config';
import { csrBody, generateKeyAndCsr } from '../src/crypto/csr';
import { certThumbprint, FIRST_PRECED, signP256, verifyP256 } from '../src/crypto/ecdsa';
import { encryptQrPayload } from '../src/crypto/qr-crypto';
import { qrPayload } from '../src/receipts/receipt-renderer';
import { MevSimulatorService } from '../src/simulator/mev-simulator.service';
import { buildTransCore, SaleDraft } from '../src/transactions/trans-builder';

const ident = { noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001' };
const headers = { envirn: 'DEV', apprlinit: 'SEV', idsev: 'a', idversi: 'b', codcertif: 'c', idpartn: 'd', versi: 'e', versiparn: 'f' };
const draft: SaleDraft = {
  documentKind: 'RECEIPT', typTrans: 'RFER', modImpr: 'FAC', formImpr: 'PAP', modTrans: 'OPE', typServ: 'LVT', ecommerce: false, modPai: 'AUT',
  lines: [{ description: 'Poutine', quantity: '1', unitPriceCents: 1299, totalCents: 1299, tax: 'FP', activity: 'RES' }],
};

describe('local simulator: CRT with a throwaway CA, UTL, TRX with signature and chain checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qcmev-sim-test-'));
  const cfg = loadConfig({ JWT_SECRET: crypto.randomBytes(32).toString('hex'), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), MEV_SIMULATOR_STATE_DIR: dir });
  const sim = new MevSimulatorService(cfg);
  let key: crypto.KeyObject;
  let certPem: string;
  let idApprl: string;
  let mevWebPem: string;

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const signedHeaders = (raw: string) => ({ ...headers, idapprl: idApprl, signatransm: signP256(key, raw), emprcertiftransm: certThumbprint(certPem) });

  it('CRT: verifies the ECDSA CSR and returns an X.509 certificate for our key', async () => {
    const { csrPem, privateKeyPem } = await generateKeyAndCsr({ utcOffset: '-05:00', nickname: 'Certificat E2E-A', sector: 'RBC', authorizationCode: 'XXXX-XXXX', noTVQ: ident.noTVQ, neq: '0000000000', fileNumber: 'ER0000' });
    key = crypto.createPrivateKey(privateKeyPem);
    const bad = await sim.enrolement({ ...headers, codautori: 'WRONG', notps: 'x', notvq: 'y' }, { reqCertif: { modif: 'AJO', csr: csrBody(csrPem) } });
    expect(bad.status).toBe(400);
    const res = await sim.enrolement({ ...headers, codautori: 'XXXX-XXXX', notps: 'x', notvq: 'y' }, { reqCertif: { modif: 'AJO', csr: csrBody(csrPem) } });
    expect(res.status).toBe(200);
    const r = (res.body as { retourCertif: { idApprl: string; certif: string; certifPSI: string } }).retourCertif;
    idApprl = r.idApprl;
    mevWebPem = `-----BEGIN CERTIFICATE-----\n${r.certifPSI.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
    certPem = `-----BEGIN CERTIFICATE-----\n${r.certif.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
    const x = new crypto.X509Certificate(certPem);
    expect(x.subject).toContain('O=RBC-XXXX-XXXX');
    expect(x.issuer).toContain('NOT REVENU QUEBEC');
    expect(verifyP256(certPem, 'abc', signP256(key, 'abc'))).toBe(true);
  });

  it('UTL AJO registers the user; an unsigned request is refused', () => {
    const body = { reqUtil: { modif: 'AJO', nomUtil: 'FOODHUB-AUTO', noTax: ident.noTVQ } };
    const raw = JSON.stringify(body);
    expect(() => sim.utilisateur({ ...signedHeaders(raw), signatransm: signP256(crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey, raw) }, raw, body)).toThrow();
    expect(sim.utilisateur(signedHeaders(raw), raw, body).status).toBe(200);
  });

  let first = '';
  it('TRX: accepts a signed transaction and returns psiNoTrans', () => {
    const { core, signedString } = buildTransCore(draft, { noTrans: '1', datTrans: '20261024120000', utc: '-04:00', datActu: '20261024120000', nomUtil: 'FOODHUB-AUTO', preced: FIRST_PRECED }, ident);
    first = signP256(key, signedString);
    const body = { reqTrans: { transActu: { ...core, signa: { actu: first, preced: FIRST_PRECED, datActu: core.datTrans }, noDossFO: 'ER0000', ...ident } } };
    const raw = JSON.stringify(body);
    const res = sim.transaction(signedHeaders(raw), raw, body as never);
    const item = (res.body as { retourTrans: { retourTransActu: { psiNoTrans?: string; listErr: unknown[] } } }).retourTrans.retourTransActu;
    expect(item.listErr).toEqual([]);
    expect(item.psiNoTrans).toMatch(/^SIM\d+$/);
  });

  it('TRX: refuses a broken chain, a reused number and a wrong total', () => {
    const send = (noTrans: string, preced: string, tamper = false) => {
      const { core, signedString } = buildTransCore(draft, { noTrans, datTrans: '20261024120500', utc: '-04:00', datActu: '20261024120500', nomUtil: 'FOODHUB-AUTO', preced }, ident);
      const t = { ...core, signa: { actu: signP256(key, signedString), preced, datActu: core.datTrans }, noDossFO: 'ER0000', ...ident };
      if (tamper) t.mont = { ...t.mont, apresTax: '99.99' };
      const body = { reqTrans: { transActu: t } };
      const raw = JSON.stringify(body);
      const res = sim.transaction(signedHeaders(raw), raw, body as never);
      return ((res.body as { retourTrans: { retourTransActu: { listErr: Array<{ id: string }> } } }).retourTrans.retourTransActu.listErr).map((e) => e.id);
    };
    expect(send('2', FIRST_PRECED)).toContain('SIM-SIGNA-PRECED');
    expect(send('1', first)).toContain('SIM-NOTRANS-DUP');
    expect(send('3', first, true)).toEqual(expect.arrayContaining(['SIM-MONT-APRESTAX']));
  });

  it('CRT REM (renewal): signed by the current certificate, same IDAPPRL, chain and users kept', async () => {
    const { csrPem, privateKeyPem } = await generateKeyAndCsr({ utcOffset: '-05:00', nickname: 'Certificat E2E-A', sector: 'RBC', authorizationCode: 'XXXX-XXXX', noTVQ: ident.noTVQ, neq: '0000000000', fileNumber: 'ER0000' });
    const crt = (noSerie: string, signer = key) => {
      const body = { reqCertif: { modif: 'REM', csr: csrBody(csrPem), noSerie } };
      const raw = JSON.stringify(body);
      return sim.enrolement({ ...headers, codautori: 'XXXX-XXXX', notps: 'x', notvq: 'y', idapprl: idApprl, signatransm: signP256(signer, raw), emprcertiftransm: certThumbprint(certPem) }, body, raw);
    };
    const serial = new crypto.X509Certificate(certPem).serialNumber;
    expect((await crt('00')).status).toBe(400); // not the current certificate
    expect((await crt(serial, crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey)).status).toBe(401); // not signed by it
    const res = await crt(serial);
    expect(res.status).toBe(200);
    const r = (res.body as { retourCertif: { idApprl: string; certif: string } }).retourCertif;
    expect(r.idApprl).toBe(idApprl);
    certPem = `-----BEGIN CERTIFICATE-----\n${r.certif.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
    key = crypto.createPrivateKey(privateKeyPem);
    // The next transaction continues the same chain (preced = the device's last signature) and the user is still registered.
    const state = (sim as unknown as { store: { get(): { devices: Record<string, { lastSignature: string | null; users: string[] }> } } }).store.get();
    const preced = state.devices[idApprl].lastSignature as string;
    expect(preced).toHaveLength(88);
    expect(state.devices[idApprl].users).toContain('FOODHUB-AUTO');
    const { core, signedString } = buildTransCore(draft, { noTrans: '4', datTrans: '20261024121000', utc: '-04:00', datActu: '20261024121000', nomUtil: 'FOODHUB-AUTO', preced }, ident);
    const body = { reqTrans: { transActu: { ...core, signa: { actu: signP256(key, signedString), preced, datActu: core.datTrans }, noDossFO: 'ER0000', ...ident } } };
    const raw = JSON.stringify(body);
    const item = (sim.transaction(signedHeaders(raw), raw, body as never).body as { retourTrans: { retourTransActu: { listErr: unknown[]; psiNoTrans?: string } } }).retourTrans.retourTransActu;
    expect(item.listErr).toEqual([]);
    expect(item.psiNoTrans).toMatch(/^SIM\d+$/);
  });

  it('mode SEV: a request that says it comes from a forwarding server (APPRLINIT=SRV) is refused', async () => {
    const res = await sim.enrolement({ ...headers, apprlinit: 'SRV', codautori: 'XXXX-XXXX', notps: 'x', notvq: 'y' }, { reqCertif: { modif: 'AJO', csr: 'x' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('SIM-APPRLINIT');
  });

  it("QR: the link data is encrypted with MEV-WEB's certificate (certifPSI) and only the simulator can read it", () => {
    const plain = qrPayload({ idApprl, noTrans: '1', datTrans: '20261024120000', apresTax: '14.94', signature: first });
    const token = encryptQrPayload(mevWebPem, plain);
    expect(token).toMatch(/^e1./);
    expect(token).not.toContain(idApprl);
    expect(Buffer.from(token.slice(3), 'base64url').toString('latin1')).not.toContain('20261024120000');
    expect(sim.lookupQr(token)).toMatchObject({ idApprl, noTrans: '1', apresTax: '14.94' });
    expect(sim.lookupQr(Buffer.from(plain).toString('base64url'))).toBeNull();
    expect(encryptQrPayload(mevWebPem, plain)).not.toBe(token); // fresh ephemeral key every time
  });
});
