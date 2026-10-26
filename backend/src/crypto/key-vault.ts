/**
 * At-rest encryption of private keys and authorization codes: AES-256-GCM with a 32-byte key
 * (PRIVATE_KEY_ENCRYPTION_KEY), a random 12-byte IV and the 16-byte auth tag. Format: v1.<iv>.<tag>.<ciphertext> (base64url).
 * Tampering or a wrong key makes decrypt() throw; nothing is padded or truncated.
 */
import * as crypto from 'crypto';

export class KeyVault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('KeyVault needs a 32-byte key');
  }

  encrypt(plain: string, context = ''): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    if (context) cipher.setAAD(Buffer.from(context, 'utf8'));
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ['v1', iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
  }

  decrypt(sealed: string, context = ''): string {
    const [v, ivB, tagB, ctB] = sealed.split('.');
    if (v !== 'v1' || !ivB || !tagB || ctB == null) throw new Error('unknown encrypted value format');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(ivB, 'base64url'));
    if (context) decipher.setAAD(Buffer.from(context, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
  }
}

export const KEY_VAULT = Symbol('KEY_VAULT');
