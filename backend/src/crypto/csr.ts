/**
 * CSR for the CRT request (ECDSA P-256 / SHA-256).
 *
 * Subject (S1: 2022 sample; every attribute must be confirmed against SW-73 before certification):
 *   C=CA, ST=QC, L=<utc offset>, SN=<nickname, 8–32 characters>, O=<sector>-<authorization code>,
 *   OU=<TVQ number>, CN=<NEQ>, GN=<mandatory-billing file number>
 * The CSR therefore carries private identity values: it is sent to MEV-WEB only and is never logged.
 */
import * as crypto from 'crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);

export const P256_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const OID_GIVEN_NAME = '2.5.4.42';

export interface CsrSubject {
  utcOffset: string;
  nickname: string;
  sector: string;
  authorizationCode: string;
  noTVQ: string;
  neq: string;
  fileNumber: string;
}

function esc(v: string): string {
  // RFC 4514 escaping for the characters that matter in a DN string.
  return v.replace(/([,+"\\<>;=])/g, '\\$1');
}

export function csrSubjectString(s: CsrSubject): string {
  if (s.nickname.length < 8 || s.nickname.length > 32) throw new RangeError('certificate nickname must be 8–32 characters');
  return [
    'C=CA',
    'ST=QC',
    `L=${esc(s.utcOffset)}`,
    `SN=${esc(s.nickname)}`,
    `O=${esc(`${s.sector}-${s.authorizationCode}`)}`,
    `OU=${esc(s.noTVQ)}`,
    `CN=${esc(s.neq)}`,
    `${OID_GIVEN_NAME}=${esc(s.fileNumber)}`,
  ].join(', ');
}

export interface GeneratedCsr {
  csrPem: string;
  privateKeyPem: string;
}

export async function generateKeyAndCsr(subject: CsrSubject): Promise<GeneratedCsr> {
  const keys = (await crypto.webcrypto.subtle.generateKey(P256_ALG, true, ['sign', 'verify'])) as unknown as CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: csrSubjectString(subject),
    keys,
    signingAlgorithm: P256_ALG,
  });
  const pkcs8 = Buffer.from(await crypto.webcrypto.subtle.exportKey('pkcs8', keys.privateKey as unknown as crypto.webcrypto.CryptoKey));
  const privateKeyPem = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString();
  return { csrPem: csr.toString('pem'), privateKeyPem };
}

/** The CSR body without PEM armour or line breaks (S1 sends it this way; SPEC). */
export function csrBody(csrPem: string): string {
  return csrPem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, '').replace(/\s+/g, '');
}
