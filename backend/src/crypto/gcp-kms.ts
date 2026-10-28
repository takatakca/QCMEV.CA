/**
 * Google Cloud KMS custody of the SEV device keys (key-custody.ts). One CryptoKey per device certificate: purpose
 * ASYMMETRIC_SIGN, algorithm EC_SIGN_P256_SHA256, protection level HSM (required in PROD). The private key is generated
 * inside KMS and never leaves it; QCMEV keeps the key version's name and asks KMS to sign the SHA-256 digest.
 *
 * REST API v1 with a service account (OAuth 2.0 JWT bearer grant), no client library. Settings in app-config.ts:
 *   QCMEV_GCP_KMS_KEY_RING     projects/<project>/locations/<region>/keyRings/<ring> (Montréal: northamerica-northeast1)
 *   QCMEV_GCP_KMS_CREDENTIALS_FILE or QCMEV_GCP_KMS_CREDENTIALS_JSON   the service account key (never in git)
 *   QCMEV_GCP_KMS_PROTECTION   HSM (default) | SOFTWARE (refused in PROD)
 * The service account needs, on that key ring only: cloudkms.cryptoKeys.create, cloudkms.cryptoKeyVersions.get,
 * .viewPublicKey, .useToSign and .update (to disable the key a renewal replaced). Never destroy or import rights.
 * KMS must answer for an invoice to be signed: keep it in the same region as QCMEV (docs/revenu-quebec/KEY_CUSTODY.md).
 */
import * as crypto from 'crypto';
import { GCP_KMS_PREFIX, KeyCustodyKind, NewSevKey, SevKeyCustody, SevSigner, derToP1363, keyContext, softwareSigner } from './key-custody';
import { KeyVault } from './key-vault';

export interface GcpKmsSettings {
  keyRing: string;
  protectionLevel: 'HSM' | 'SOFTWARE';
  credentials: { clientEmail: string; privateKey: string; tokenUri: string };
  /** https://cloudkms.googleapis.com */
  endpoint: string;
}

export const GCP_KEY_RING = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{2,40}\/keyRings\/[A-Za-z0-9_-]{1,63}$/;
const KEY_VERSION = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z0-9-]{2,40}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63}\/cryptoKeyVersions\/\d{1,10}$/;
const SCOPE = 'https://www.googleapis.com/auth/cloudkms';
const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

export class GcpKmsKeyCustody implements SevKeyCustody {
  readonly kind = 'gcp-kms' as const;
  private token: { value: string; until: number } | null = null;
  private readonly publicKeys = new Map<string, crypto.KeyObject>();

  constructor(
    private readonly s: GcpKmsSettings,
    private readonly vault: KeyVault,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init),
    private readonly opts: { pollMs?: number; maxWaitMs?: number; timeoutMs?: number } = {},
  ) {
    if (!GCP_KEY_RING.test(s.keyRing)) throw new Error('QCMEV_GCP_KMS_KEY_RING must be projects/<project>/locations/<region>/keyRings/<ring>');
  }

  async createKey(deviceId: string): Promise<NewSevKey> {
    const id = `sev-${deviceId.replace(/[^A-Za-z0-9]/g, '').slice(0, 32)}-${Date.now().toString(36)}`;
    const key = await this.call<{ name?: string }>('POST', `/v1/${this.s.keyRing}/cryptoKeys?cryptoKeyId=${encodeURIComponent(id)}`, {
      purpose: 'ASYMMETRIC_SIGN',
      versionTemplate: { algorithm: 'EC_SIGN_P256_SHA256', protectionLevel: this.s.protectionLevel },
      labels: { app: 'qcmev', role: 'sev-device-key' },
    });
    const version = `${key.name ?? `${this.s.keyRing}/cryptoKeys/${id}`}/cryptoKeyVersions/1`;
    await this.waitEnabled(version);
    const signer = await this.signerFor(version);
    return { ...signer, sealed: this.vault.encrypt(GCP_KMS_PREFIX + version, keyContext(deviceId)) };
  }

  async open(sealed: string, deviceId: string): Promise<SevSigner> {
    const plain = this.vault.decrypt(sealed, keyContext(deviceId));
    // A device certified before the switch keeps its software key (refused in PROD by CertificatesService).
    if (!plain.startsWith(GCP_KMS_PREFIX)) return softwareSigner(plain);
    return this.signerFor(this.versionOf(plain));
  }

  kindOf(sealed: string, deviceId: string): KeyCustodyKind {
    return this.vault.decrypt(sealed, keyContext(deviceId)).startsWith(GCP_KMS_PREFIX) ? 'gcp-kms' : 'software';
  }

  async retire(sealed: string, deviceId: string): Promise<void> {
    const plain = this.vault.decrypt(sealed, keyContext(deviceId));
    if (!plain.startsWith(GCP_KMS_PREFIX)) return;
    // Disabled, not destroyed: a person can turn it back on if the renewal has to be undone.
    await this.call('PATCH', `/v1/${this.versionOf(plain)}?updateMask=state`, { state: 'DISABLED' });
  }

  private versionOf(plain: string): string {
    const v = plain.slice(GCP_KMS_PREFIX.length);
    if (!KEY_VERSION.test(v)) throw new Error('stored KMS key name is malformed');
    return v;
  }

  /** HSM keys are generated asynchronously: PENDING_GENERATION, then ENABLED. */
  private async waitEnabled(version: string): Promise<void> {
    const until = Date.now() + (this.opts.maxWaitMs ?? 60_000);
    for (;;) {
      const v = await this.call<{ state?: string }>('GET', `/v1/${version}`);
      if (v.state === 'ENABLED') return;
      if (v.state !== 'PENDING_GENERATION') throw new Error(`KMS key ${version} is ${v.state ?? 'in an unknown state'}`);
      if (Date.now() >= until) throw new Error(`KMS key ${version} still generating after ${(this.opts.maxWaitMs ?? 60_000) / 1000} s`);
      await new Promise((r) => setTimeout(r, this.opts.pollMs ?? 1000));
    }
  }

  private async signerFor(version: string): Promise<SevSigner> {
    let publicKey = this.publicKeys.get(version);
    if (!publicKey) {
      const pk = await this.call<{ pem?: string; algorithm?: string }>('GET', `/v1/${version}/publicKey`);
      if (pk.algorithm !== 'EC_SIGN_P256_SHA256' || !pk.pem) throw new Error(`KMS key ${version} is not EC_SIGN_P256_SHA256`);
      publicKey = crypto.createPublicKey(pk.pem);
      if (publicKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error(`KMS key ${version} is not a P-256 key`);
      this.publicKeys.set(version, publicKey);
    }
    const key = publicKey;
    const signP1363 = async (data: Buffer): Promise<Buffer> => {
      const digest = crypto.createHash('sha256').update(data).digest();
      const res = await this.call<{ signature?: string; name?: string }>('POST', `/v1/${version}:asymmetricSign`, { digest: { sha256: digest.toString('base64') } });
      if (!res.signature || (res.name && res.name !== version)) throw new Error('KMS answered without a signature from this key');
      const sig = derToP1363(Buffer.from(res.signature, 'base64'));
      // Never use a signature that does not verify (corrupted answer, wrong key).
      if (!crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig)) throw new Error('KMS signature does not verify with the key');
      return sig;
    };
    return {
      kind: 'gcp-kms',
      publicKey: key,
      signP1363,
      sign: async (data) => (await signP1363(typeof data === 'string' ? Buffer.from(data, 'utf8') : data)).toString('base64'),
    };
  }

  private async call<T>(method: string, path: string, body?: unknown, retried = false): Promise<T> {
    const res = await this.fetchFn(`${this.s.endpoint}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    if (res.status === 401 && !retried) {
      this.token = null;
      return this.call<T>(method, path, body, true);
    }
    const text = await res.text();
    if (!res.ok) {
      const msg = (() => {
        try {
          return String(JSON.parse(text)?.error?.message ?? '').slice(0, 200);
        } catch {
          return '';
        }
      })();
      throw new Error(`Google Cloud KMS ${method} HTTP ${res.status}${msg ? `: ${msg}` : ''}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** OAuth 2.0 access token for the service account (JWT bearer grant), kept until a minute before it expires. */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const iat = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(JSON.stringify({ iss: this.s.credentials.clientEmail, scope: SCOPE, aud: this.s.credentials.tokenUri, iat, exp: iat + 3600 }));
    const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), this.s.credentials.privateKey).toString('base64url');
    const res = await this.fetchFn(this.s.credentials.tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }).toString(),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
    });
    const j = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!res.ok || !j?.access_token) throw new Error(`Google OAuth token HTTP ${res.status}: the KMS service account was refused`);
    this.token = { value: j.access_token, until: Date.now() + Math.max(60, (j.expires_in ?? 3600) - 60) * 1000 };
    return this.token.value;
  }
}
