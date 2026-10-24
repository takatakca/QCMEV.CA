/**
 * Encryption of the QR code's web address data with MEV-WEB's certificate (certifPSI, returned by the CRT request).
 *
 * PROVEN (SW-76 2025-06, §4.2.1): the CRT request gives two certificates, one of them "le certificat du MEV-WEB
 * permettant de chiffrer les renseignements de l'hyperlien inclus dans le code QR". So the data behind the QR link is
 * never sent in clear.
 * SPEC: the exact scheme and payload wait for SW-73.B. Until then, a standard hybrid scheme keyed on the certificate:
 *   - EC key (P-256):  "e1." + base64url(ephemeral public key 65 bytes ‖ iv 12 ‖ tag 16 ‖ AES-256-GCM ciphertext),
 *                      key = HKDF-SHA256(ECDH(ephemeral, certificate key), info "QCMEV-QR-v1", 32 bytes);
 *   - RSA key:         "r1." + base64url(RSA-OAEP-SHA256 ciphertext).
 * Only the holder of MEV-WEB's private key (our local simulator, in tests) can read it.
 */
import * as crypto from 'crypto';

const INFO = Buffer.from('QCMEV-QR-v1', 'utf8');

function hkdf(secret: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.alloc(0), INFO, 32));
}

/** Encrypts the QR payload for the certificate's public key. Throws on a key type MEV-WEB would not use. */
export function encryptQrPayload(certPem: string, plain: string): string {
  const pub = new crypto.X509Certificate(certPem).publicKey;
  if (pub.asymmetricKeyType === 'ec') {
    const curve = pub.asymmetricKeyDetails?.namedCurve;
    if (curve !== 'prime256v1') throw new Error(`MEV-WEB certificate curve ${curve ?? '?'} is not supported for the QR code`);
    const eph = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const key = hkdf(crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: pub }));
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    const ephRaw = eph.publicKey.export({ format: 'jwk' });
    const point = Buffer.concat([Buffer.from([4]), Buffer.from(ephRaw.x as string, 'base64url'), Buffer.from(ephRaw.y as string, 'base64url')]);
    return `e1.${Buffer.concat([point, iv, c.getAuthTag(), ct]).toString('base64url')}`;
  }
  if (pub.asymmetricKeyType === 'rsa') {
    const ct = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(plain, 'utf8'));
    return `r1.${ct.toString('base64url')}`;
  }
  throw new Error(`MEV-WEB certificate key type ${pub.asymmetricKeyType ?? '?'} is not supported for the QR code`);
}

/** The reverse, for the holder of MEV-WEB's private key (our local simulator only). */
export function decryptQrPayload(privateKeyPem: string, token: string): string {
  const priv = crypto.createPrivateKey(privateKeyPem);
  const [v, body] = token.split('.', 2);
  const raw = Buffer.from(body ?? '', 'base64url');
  if (v === 'e1') {
    if (raw.length < 65 + 12 + 16) throw new Error('QR payload too short');
    const point = raw.subarray(0, 65);
    const ephPub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33, 65).toString('base64url') }, format: 'jwk' });
    const key = hkdf(crypto.diffieHellman({ privateKey: priv, publicKey: ephPub }));
    const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(65, 77));
    d.setAuthTag(raw.subarray(77, 93));
    return Buffer.concat([d.update(raw.subarray(93)), d.final()]).toString('utf8');
  }
  if (v === 'r1') return crypto.privateDecrypt({ key: priv, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, raw).toString('utf8');
  throw new Error('unknown QR payload format');
}
