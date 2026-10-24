import * as crypto from 'crypto';
import { KeyVault } from '../src/crypto/key-vault';

describe('AES-256-GCM key vault', () => {
  const vault = new KeyVault(crypto.randomBytes(32));

  it('round-trips and uses a fresh IV each time', () => {
    const a = vault.encrypt('-----BEGIN PRIVATE KEY-----x', 'key:dev1');
    const b = vault.encrypt('-----BEGIN PRIVATE KEY-----x', 'key:dev1');
    expect(a).not.toBe(b);
    expect(a.startsWith('v1.')).toBe(true);
    expect(vault.decrypt(a, 'key:dev1')).toBe('-----BEGIN PRIVATE KEY-----x');
  });

  it('detects tampering (auth tag)', () => {
    const s = vault.encrypt('secret', 'ctx').split('.');
    const ct = Buffer.from(s[3], 'base64url');
    ct[0] ^= 1;
    s[3] = ct.toString('base64url');
    expect(() => vault.decrypt(s.join('.'), 'ctx')).toThrow();
  });

  it('refuses a wrong context or a wrong key', () => {
    const s = vault.encrypt('secret', 'auth:dev1');
    expect(() => vault.decrypt(s, 'auth:dev2')).toThrow();
    expect(() => new KeyVault(crypto.randomBytes(32)).decrypt(s, 'auth:dev1')).toThrow();
  });

  it('needs exactly 32 bytes', () => {
    expect(() => new KeyVault(crypto.randomBytes(16))).toThrow();
  });
});
