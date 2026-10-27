/**
 * ECDSA P-256 / SHA-256 signatures (PROVEN: the signature is 64 bytes r||s in base64, i.e. 88 characters;
 * Revenu Québec error codes JW00B999606E/607E/608E check its length and format).
 */
import * as crypto from 'crypto';

/** signa.preced of the very first transaction of a device: 88 "=" (PROVEN, 2022 sample). */
export const FIRST_PRECED = '='.repeat(88);
export const SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;

export interface PemKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateP256(): PemKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export function signP256(privateKey: crypto.KeyObject | string, data: string | Buffer): string {
  const key = typeof privateKey === 'string' ? crypto.createPrivateKey(privateKey) : privateKey;
  const sig = crypto.sign('sha256', typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { key, dsaEncoding: 'ieee-p1363' });
  if (sig.length !== 64) throw new Error(`unexpected signature length ${sig.length}`);
  return sig.toString('base64');
}

/** Verifies against a public key PEM, a certificate PEM, or a KeyObject. */
export function verifyP256(key: crypto.KeyObject | string, data: string | Buffer, signatureB64: string): boolean {
  if (!SIGNATURE_RE.test(signatureB64)) return false;
  try {
    const pub: crypto.KeyObject =
      typeof key !== 'string' ? key : key.includes('BEGIN CERTIFICATE') ? new crypto.X509Certificate(key).publicKey : crypto.createPublicKey(key);
    return crypto.verify('sha256', typeof data === 'string' ? Buffer.from(data, 'utf8') : data, { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(signatureB64, 'base64'));
  } catch {
    return false;
  }
}

export interface SignedFields {
  noTrans: string;
  datTrans: string;
  TPS: string;
  TVQ: string;
  apresTax: string;
  noTPS: string;
  noTVQ: string;
  modImpr: string;
  modTrans: string;
  preced: string;
}

/**
 * The string covered by signa.actu (S1: 2022 sample order; must be confirmed against SW-73 before certification).
 * noTrans + datTrans + TPS + TVQ + apresTax + noTPS + noTVQ + modImpr + modTrans + signa.preced
 */
export function transactionSignedString(f: SignedFields): string {
  return [f.noTrans, f.datTrans, f.TPS, f.TVQ, f.apresTax, f.noTPS, f.noTVQ, f.modImpr, f.modTrans, f.preced].join('');
}

/** SHA-1 thumbprint of a certificate, hex lowercase (EMPRCERTIFTRANSM header, S1). */
export function certThumbprint(certPem: string): string {
  return new crypto.X509Certificate(certPem).fingerprint.replace(/:/g, '').toLowerCase();
}

/** Internal audit chain (never transmitted): sha256(previous | canonical record). */
export function nextHashChain(previous: string, record: string): string {
  return crypto.createHash('sha256').update(`${previous}|${record}`).digest('hex');
}

export const GENESIS_HASH = '0'.repeat(64);
