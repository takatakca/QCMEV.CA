import * as crypto from 'crypto';
import { ConfigError, loadConfig } from '../src/config/app-config';

const good = () => ({
  JWT_SECRET: crypto.randomBytes(32).toString('hex'),
  PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
});

describe('configuration: no default secret, the environment really decides', () => {
  it('starts in SIMULATOR with strong secrets; simulator mounted on the local URL', () => {
    const c = loadConfig({ ...good(), PORT: '3005' });
    expect(c.mevEnvironment).toBe('SIMULATOR');
    expect(c.envirnHeader).toBe('DEV');
    expect(c.simulatorEnabled).toBe(true);
    expect(c.mevBaseUrl).toBe('http://127.0.0.1:3005/api/mev-simulator');
    expect(c.qrBaseUrl).not.toMatch(/revenuquebec|mev-web\.ca/);
    expect(c.certified).toBe(false);
    expect(c.foodhub.enabled).toBe(false);
  });

  it('refuses missing or weak secrets', () => {
    expect(() => loadConfig({ PRIVATE_KEY_ENCRYPTION_KEY: good().PRIVATE_KEY_ENCRYPTION_KEY })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good(), JWT_SECRET: 'CHANGE-THIS-IN-PRODUCTION-USE-A-LONG-RANDOM-STRING' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good(), JWT_SECRET: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good(), PRIVATE_KEY_ENCRYPTION_KEY: 'CHANGE-THIS-32-CHAR-KEY-IN-PROD!!' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good(), PRIVATE_KEY_ENCRYPTION_KEY: '00'.repeat(32) })).toThrow(ConfigError);
  });

  it('accepts a base64 32-byte encryption key', () => {
    expect(loadConfig({ ...good(), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64') }).keyEncryptionKey).toHaveLength(32);
  });

  it('refuses PROD without a certification number', () => {
    expect(() => loadConfig({ ...good(), MEV_ENVIRONMENT: 'PROD', MEV_WEB_BASE_URL: 'https://example.invalid' })).toThrow(/QCMEV_CERTIFICATION_NUMBER/);
  });

  it('never mounts the simulator in ESSAI or PROD and needs the real ids there', () => {
    const ids = { MEV_IDSEV: 'a', MEV_IDVERSI: 'b', MEV_CODCERTIF: 'c', MEV_IDPARTN: 'd', MEV_VERSI: 'e', MEV_VERSIPARN: 'f', MEV_WEB_BASE_URL: 'https://example.invalid', MEV_QR_BASE_URL: 'https://example.invalid/qr' };
    const essai = loadConfig({ ...good(), ...ids, MEV_ENVIRONMENT: 'ESSAI' });
    expect(essai.simulatorEnabled).toBe(false);
    expect(essai.envirnHeader).toBe('ESSAI');
    expect(() => loadConfig({ ...good(), MEV_ENVIRONMENT: 'ESSAI', MEV_WEB_BASE_URL: 'https://example.invalid' })).toThrow(ConfigError);
    // Even certified, PROD waits for a non-exportable key custody (SW-76 §4.2.1).
    expect(() => loadConfig({ ...good(), ...ids, MEV_ENVIRONMENT: 'PROD', QCMEV_CERTIFICATION_NUMBER: 'TEST-NUMBER' })).toThrow(/non-exportable/);
    expect(() => loadConfig({ ...good(), SEV_KEY_CUSTODY: 'hsm' })).toThrow(/not built/);
    expect(essai.keyCustody).toBe('software');
  });

  it('refuses an unknown environment and the Food Hub switch without a strong secret', () => {
    expect(() => loadConfig({ ...good(), MEV_ENVIRONMENT: 'PRODUCTION' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good(), QCMEV_FOODHUB_ENABLED: 'true' })).toThrow(/QCMEV_FOODHUB_SECRET/);
    expect(() => loadConfig({ ...good(), QCMEV_FOODHUB_ENABLED: 'true', QCMEV_FOODHUB_SECRET: 'too-short' })).toThrow(ConfigError);
    expect(loadConfig({ ...good(), QCMEV_FOODHUB_ENABLED: 'true', QCMEV_FOODHUB_SECRET: crypto.randomBytes(32).toString('hex') }).foodhub.enabled).toBe(true);
  });
});


describe('connection and scheduler numeric configuration', () => {
  it.each(['MEV_TIMEOUT_MS', 'QCMEV_FOODHUB_RATE_PER_SECOND', 'MEV_OFFLINE_FLUSH_SECONDS', 'PORT'])(
    'refuses invalid %s rather than silently creating an unbounded timeout or a fast timer', (name) => {
      for (const value of ['NaN', 'Infinity', '-1', '1.5']) expect(() => loadConfig({ ...good(), [name]: value })).toThrow(ConfigError);
    },
  );
  it('allows disabling the offline scheduler explicitly and validates the port range', () => {
    expect(loadConfig({ ...good(), MEV_OFFLINE_FLUSH_SECONDS: '0' }).offlineFlushSeconds).toBe(0);
    expect(() => loadConfig({ ...good(), MEV_TIMEOUT_MS: '0' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good(), PORT: '65536' })).toThrow(ConfigError);
  });
});


describe('JWT duration configuration', () => {
  it('requires an explicit unit, so a numeric-looking string cannot silently become milliseconds', () => {
    expect(loadConfig({ ...good(), JWT_EXPIRES_IN: '30m' }).jwtExpiresIn).toBe('30m');
    for (const value of ['3600', 'forever', '0h', '-1h']) expect(() => loadConfig({ ...good(), JWT_EXPIRES_IN: value })).toThrow(ConfigError);
  });
});
