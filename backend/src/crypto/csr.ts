/**
 * CSR for the CRT request (ECDSA P-256 / SHA-256).
 *
 * Subject (S1: 2022 sample; every attribute must be confirmed against SW-73 before certification):
 *   C=CA, ST=QC, L=<utc>, SN=<nickname, 8–32 characters>, O=<sector>-<authorization code>,
 *   OU=<TVQ number>, CN=<NEQ>, GN=<mandatory-billing file number>
 * L = the UTC associated with the business address (PROVEN, « Configuration du système d'enregistrement des ventes »):
 * « -05:00 », or « -04:00 » for Îles-de-la-Madeleine and Basse-Côte-Nord. It is a fixed value of the address, never
 * the daylight-saving offset of the day the certificate is requested (Operator.addressUtc).
 * The CSR therefore carries private identity values: it is sent to MEV-WEB only and is never logged.
 */
import * as crypto from 'crypto';
import * as x509 from '@peculiar/x509';

x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);

export const P256_ALG = { name: 'ECDSA', namedCurve: 'P-256', hash: 'SHA-256' } as const;
const OID_GIVEN_NAME = '2.5.4.42';

/** The only two values Revenu Québec lists for the UTC of a business address in Québec. */
export const ADDRESS_UTC_VALUES = ['-05:00', '-04:00'] as const;
export type AddressUtc = (typeof ADDRESS_UTC_VALUES)[number];

/** The operator's address UTC, "-05:00" when not set; anything else is refused (it is not a time-of-day offset). */
export function addressUtcOf(op: { addressUtc?: string | null }): AddressUtc {
  const v = op.addressUtc ?? '-05:00';
  if (!(ADDRESS_UTC_VALUES as readonly string[]).includes(v)) throw new RangeError(`addressUtc must be -05:00 or -04:00 (got ${v})`);
  return v as AddressUtc;
}

export interface CsrSubject {
  /** L=: the UTC associated with the business address (ADDRESS_UTC_VALUES). */
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
  if (!(ADDRESS_UTC_VALUES as readonly string[]).includes(s.utcOffset)) throw new RangeError('L= must be the address UTC: -05:00 or -04:00');
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

/** The bytes of a WebCrypto BufferSource. */
function bytesOf(data: BufferSource): Buffer {
  return ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : Buffer.from(data as ArrayBuffer);
}

/**
 * The same CSR (subject, ECDSA P-256 / SHA-256) for a key held outside this process (Google Cloud KMS, key-custody.ts):
 * the request is assembled here and only its signature is asked from the key. Checked before it is returned.
 */
export async function csrForKey(subject: CsrSubject, key: { publicKey: crypto.KeyObject; signP1363(data: Buffer): Promise<Buffer> }): Promise<string> {
  const subtle = crypto.webcrypto.subtle;
  const publicKey = await subtle.importKey('spki', key.publicKey.export({ type: 'spki', format: 'der' }), P256_ALG, true, ['verify']);
  // Stands for the remote private key: the generator reads its algorithm and hands it back to sign().
  const remote = { type: 'private', extractable: false, algorithm: { name: 'ECDSA', namedCurve: 'P-256' }, usages: ['sign'] };
  const remoteCrypto = {
    getRandomValues: <T extends ArrayBufferView | null>(a: T) => crypto.webcrypto.getRandomValues(a as never) as T,
    subtle: new Proxy(subtle, {
      get(target, prop) {
        if (prop === 'sign') {
          return async (alg: unknown, k: unknown, data: BufferSource) => {
            if (k !== remote) return target.sign(alg as never, k as never, data as never);
            const sig = await key.signP1363(bytesOf(data));
            return sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength);
          };
        }
        const v = Reflect.get(target, prop, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }),
  };
  const csr = await x509.Pkcs10CertificateRequestGenerator.create(
    { name: csrSubjectString(subject), keys: { publicKey: publicKey as unknown as CryptoKey, privateKey: remote as unknown as CryptoKey }, signingAlgorithm: P256_ALG },
    remoteCrypto as unknown as Crypto,
  );
  if (!(await csr.verify(crypto.webcrypto as unknown as Crypto))) throw new Error('the CSR signature does not verify with the key');
  return csr.toString('pem');
}

/** The CSR body without PEM armour or line breaks (S1 sends it this way; SPEC). */
export function csrBody(csrPem: string): string {
  return csrPem.replace(/-----(BEGIN|END) CERTIFICATE REQUEST-----/g, '').replace(/\s+/g, '');
}
