/**
 * SEV key custody (SW-76 §4.2.1, non-exportable key): software keys (SIMULATOR / DEV / ESSAI) and Google Cloud KMS
 * (crypto/gcp-kms.ts) against an in-memory KMS that signs digests like the real one (test/fake-gcp-kms.ts).
 */
import * as crypto from 'crypto';
import * as x509 from '@peculiar/x509';
import { ConfigError, loadConfig } from '../src/config/app-config';
import { csrForKey } from '../src/crypto/csr';
import { verifyP256 } from '../src/crypto/ecdsa';
import { GcpKmsKeyCustody, GcpKmsSettings } from '../src/crypto/gcp-kms';
import { derToP1363, GCP_KMS_PREFIX, SoftwareKeyCustody } from '../src/crypto/key-custody';
import { KeyVault } from '../src/crypto/key-vault';
import { createFakeKms, FakeKms } from './fake-gcp-kms';

const RING = 'projects/takatak-mev-test/locations/northamerica-northeast1/keyRings/qcmev-sev';
const DEVICE = '9f1c2b7e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';
const subject = { utcOffset: '-05:00', nickname: 'Certificat 0001', sector: 'RBC', authorizationCode: 'XXXX-XXXX', noTVQ: '0000000000TQ0001', neq: '0000000000', fileNumber: 'ER0000' };

const vault = () => new KeyVault(crypto.randomBytes(32));
function kmsCustody(kms: FakeKms, v = vault(), protectionLevel: GcpKmsSettings['protectionLevel'] = 'HSM') {
  const s: GcpKmsSettings = {
    keyRing: RING,
    protectionLevel,
    credentials: { clientEmail: kms.serviceAccount.client_email, privateKey: kms.serviceAccount.private_key, tokenUri: kms.serviceAccount.token_uri },
    endpoint: 'https://kms.test',
  };
  return new GcpKmsKeyCustody(s, v, kms.fetch, { pollMs: 1, maxWaitMs: 2000 });
}

describe('signature format', () => {
  it('a DER ECDSA signature becomes the 64-byte r||s Revenu Québec expects, and verifies', () => {
    for (let i = 0; i < 40; i++) {
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const data = crypto.randomBytes(50);
      const der = crypto.sign('sha256', data, { key: privateKey, dsaEncoding: 'der' });
      const raw = derToP1363(der);
      expect(raw).toHaveLength(64);
      expect(crypto.verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
    }
    expect(() => derToP1363(Buffer.from('300602010102', 'hex'))).toThrow(/invalid DER/);
    expect(() => derToP1363(Buffer.alloc(70, 1))).toThrow(/invalid DER/);
  });
});

describe('software custody (SIMULATOR / DEV / ESSAI)', () => {
  it('creates a sealed key that signs 88-character signatures; the sealed value is not the key in clear', async () => {
    const v = vault();
    const c = new SoftwareKeyCustody(v);
    const key = await c.createKey(DEVICE);
    expect(key.sealed).not.toContain('PRIVATE KEY');
    expect(v.decrypt(key.sealed, `key:${DEVICE}`)).toContain('BEGIN PRIVATE KEY');
    expect(c.kindOf(key.sealed, DEVICE)).toBe('software');
    const opened = await c.open(key.sealed, DEVICE);
    const sig = await opened.sign('noTrans1datTrans');
    expect(sig).toHaveLength(88);
    expect(verifyP256(key.publicKey, 'noTrans1datTrans', sig)).toBe(true);
    // Sealed for this device only (the device id is the AES-GCM context).
    await expect(c.open(key.sealed, 'another-device')).rejects.toThrow();
  });
});

describe('Google Cloud KMS custody (the key never leaves KMS)', () => {
  it('creates an HSM key in the key ring, waits for it, stores only its name, and signs with it', async () => {
    const kms = createFakeKms({ pendingPolls: 2 });
    const v = vault();
    const c = kmsCustody(kms, v);
    const key = await c.createKey(DEVICE);
    const stored = v.decrypt(key.sealed, `key:${DEVICE}`);
    expect(stored.startsWith(GCP_KMS_PREFIX)).toBe(true);
    expect(stored).not.toContain('PRIVATE KEY');
    expect(stored).toMatch(new RegExp(`^kms:gcp:${RING}/cryptoKeys/sev-9f1c2b7e1d2a4c3b9e8f0a1b2c3d4e5f-[a-z0-9]+/cryptoKeyVersions/1$`));
    const k = kms.keys.get(stored.slice(GCP_KMS_PREFIX.length))!;
    expect(k).toMatchObject({ protectionLevel: 'HSM', algorithm: 'EC_SIGN_P256_SHA256', state: 'ENABLED' });
    expect(key.publicKey.export({ type: 'spki', format: 'der' }).equals(k.publicKey.export({ type: 'spki', format: 'der' }))).toBe(true);

    const sig = await key.sign('noTrans1datTrans2TPS3');
    expect(sig).toHaveLength(88);
    expect(verifyP256(k.publicKey, 'noTrans1datTrans2TPS3', sig)).toBe(true);
    expect(c.kindOf(key.sealed, DEVICE)).toBe('gcp-kms');
  });

  it('a stored key opens again later (new process) and signs; one access token is reused', async () => {
    const kms = createFakeKms();
    const v = vault();
    const sealed = (await kmsCustody(kms, v).createKey(DEVICE)).sealed;
    const later = kmsCustody(kms, v);
    const signer = await later.open(sealed, DEVICE);
    const before = kms.tokensIssued;
    for (const s of ['a', 'b', 'c']) expect(verifyP256(signer.publicKey, s, await signer.sign(s))).toBe(true);
    expect(kms.tokensIssued).toBe(before);
  });

  it('never uses a signature that does not verify with the key (a wrong or corrupted answer)', async () => {
    const kms = createFakeKms();
    const key = await kmsCustody(kms).createKey(DEVICE);
    kms.corruptNextSignature = true;
    await expect(key.sign('data')).rejects.toThrow(/does not verify/);
    expect(verifyP256(key.publicKey, 'data', await key.sign('data'))).toBe(true);
  });

  it('the CRT request (CSR) is signed inside KMS: same subject, verifies, carries the KMS public key', async () => {
    const kms = createFakeKms();
    const key = await kmsCustody(kms).createKey(DEVICE);
    const pem = await csrForKey(subject, key);
    const csr = new x509.Pkcs10CertificateRequest(pem);
    expect(await csr.verify(crypto.webcrypto as unknown as Crypto)).toBe(true);
    expect(csr.subjectName.getField('L')[0]).toBe('-05:00');
    expect(csr.subjectName.getField('CN')[0]).toBe('0000000000');
    const spki = Buffer.from(csr.publicKey.rawData);
    expect(spki.equals(key.publicKey.export({ type: 'spki', format: 'der' }))).toBe(true);
    expect(kms.calls.some((c) => c.path.endsWith(':asymmetricSign'))).toBe(true);
  });

  it('a renewal disables the replaced key (not destroyed); it signs nothing more', async () => {
    const kms = createFakeKms();
    const c = kmsCustody(kms);
    const key = await c.createKey(DEVICE);
    await c.retire(key.sealed, DEVICE);
    expect([...kms.keys.values()][0].state).toBe('DISABLED');
    await expect(key.sign('x')).rejects.toThrow(/HTTP 400/);
  });

  it('a device certified with a software key keeps signing after the switch (refused in PROD by CertificatesService)', async () => {
    const v = vault();
    const sealed = (await new SoftwareKeyCustody(v).createKey(DEVICE)).sealed;
    const c = kmsCustody(createFakeKms(), v);
    expect(c.kindOf(sealed, DEVICE)).toBe('software');
    const s = await c.open(sealed, DEVICE);
    expect(verifyP256(s.publicKey, 'x', await s.sign('x'))).toBe(true);
    // And the other way: a KMS key is never opened as a software key.
    const kmsSealed = (await c.createKey(DEVICE)).sealed;
    await expect(new SoftwareKeyCustody(v).open(kmsSealed, DEVICE)).rejects.toThrow(/SEV_KEY_CUSTODY=gcp-kms/);
  });

  it('a refused service account or a malformed stored name stops with a clear error', async () => {
    const kms = createFakeKms();
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const s: GcpKmsSettings = { keyRing: RING, protectionLevel: 'HSM', credentials: { clientEmail: kms.serviceAccount.client_email, privateKey: other, tokenUri: kms.serviceAccount.token_uri }, endpoint: 'https://kms.test' };
    await expect(new GcpKmsKeyCustody(s, vault(), kms.fetch).createKey(DEVICE)).rejects.toThrow(/service account was refused/);
    const v = vault();
    await expect(kmsCustody(kms, v).open(v.encrypt(`${GCP_KMS_PREFIX}projects/x/../etc`, `key:${DEVICE}`), DEVICE)).rejects.toThrow(/malformed/);
    expect(() => new GcpKmsKeyCustody({ ...s, keyRing: 'projects/a' }, vault(), kms.fetch)).toThrow(/KEY_RING/);
  });
});

describe('configuration: PROD only with a non-exportable key in an HSM', () => {
  const secrets = () => ({ JWT_SECRET: crypto.randomBytes(32).toString('hex'), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') });
  const ids = { MEV_IDSEV: 'a', MEV_IDVERSI: 'b', MEV_CODCERTIF: 'c', MEV_IDPARTN: 'd', MEV_VERSI: 'e', MEV_VERSIPARN: 'f', MEV_WEB_BASE_URL: 'https://example.invalid', MEV_QR_BASE_URL: 'https://example.invalid/qr' };
  const sa = JSON.stringify(createFakeKms({ tokenUri: 'https://oauth2.googleapis.com/token' }).serviceAccount);
  const kms = { SEV_KEY_CUSTODY: 'gcp-kms', QCMEV_GCP_KMS_KEY_RING: RING, QCMEV_GCP_KMS_CREDENTIALS_JSON: sa };

  it('PROD loads with Google Cloud KMS at HSM level and a certification number — and only then', () => {
    const c = loadConfig({ ...secrets(), ...ids, ...kms, MEV_ENVIRONMENT: 'PROD', QCMEV_CERTIFICATION_NUMBER: 'TEST-NUMBER' });
    expect(c).toMatchObject({ keyCustody: 'gcp-kms', certified: true, gcpKms: { keyRing: RING, protectionLevel: 'HSM', endpoint: 'https://cloudkms.googleapis.com' } });
    expect(c.gcpKms?.credentials.tokenUri).toBe('https://oauth2.googleapis.com/token');
    expect(() => loadConfig({ ...secrets(), ...ids, ...kms, QCMEV_GCP_KMS_PROTECTION: 'SOFTWARE', MEV_ENVIRONMENT: 'PROD', QCMEV_CERTIFICATION_NUMBER: 'TEST-NUMBER' })).toThrow(/non-exportable/);
    expect(() => loadConfig({ ...secrets(), ...ids, MEV_ENVIRONMENT: 'PROD', QCMEV_CERTIFICATION_NUMBER: 'TEST-NUMBER' })).toThrow(/non-exportable/);
    expect(() => loadConfig({ ...secrets(), ...ids, ...kms, MEV_ENVIRONMENT: 'PROD' })).toThrow(/QCMEV_CERTIFICATION_NUMBER/);
  });

  it('refuses an incomplete or doubtful KMS setting', () => {
    expect(() => loadConfig({ ...secrets(), SEV_KEY_CUSTODY: 'gcp-kms' })).toThrow(/QCMEV_GCP_KMS_KEY_RING/);
    expect(() => loadConfig({ ...secrets(), ...kms, QCMEV_GCP_KMS_KEY_RING: 'my-ring' })).toThrow(/keyRings/);
    expect(() => loadConfig({ ...secrets(), ...kms, QCMEV_GCP_KMS_CREDENTIALS_FILE: '/nowhere.json' })).toThrow(/exactly one/);
    expect(() => loadConfig({ ...secrets(), ...kms, QCMEV_GCP_KMS_CREDENTIALS_JSON: '{"type":"authorized_user"}' })).toThrow(/service account/);
    expect(() => loadConfig({ ...secrets(), ...kms, QCMEV_GCP_KMS_PROTECTION: 'EXTERNAL' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...secrets(), SEV_KEY_CUSTODY: 'gcp-kms', QCMEV_GCP_KMS_KEY_RING: RING, QCMEV_GCP_KMS_CREDENTIALS_FILE: '/nowhere.json' })).toThrow(/cannot be read/);
  });

  it('a local http fake KMS is accepted in SIMULATOR only, never in ESSAI or PROD', () => {
    const local = { ...kms, QCMEV_GCP_KMS_ENDPOINT: 'http://127.0.0.1:4555' };
    expect(loadConfig({ ...secrets(), ...local }).gcpKms?.endpoint).toBe('http://127.0.0.1:4555');
    expect(() => loadConfig({ ...secrets(), ...ids, ...local, MEV_ENVIRONMENT: 'ESSAI' })).toThrow(/https/);
    expect(() => loadConfig({ ...secrets(), ...ids, ...local, MEV_ENVIRONMENT: 'PROD', QCMEV_CERTIFICATION_NUMBER: 'TEST-NUMBER' })).toThrow(/https/);
  });
});
