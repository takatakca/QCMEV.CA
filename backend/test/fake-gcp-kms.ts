/**
 * Test double of Google Cloud KMS (REST v1) and Google's OAuth token endpoint, in memory: create key (HSM keys start
 * PENDING_GENERATION), get version, public key, asymmetricSign over a SHA-256 digest, disable. Checks the bearer token
 * and the service account's JWT like Google does. Not a mock of our code: it signs the digest it is given, so the
 * signatures are real ECDSA P-256 signatures (computed here, as KMS does, from the digest only).
 */
import * as crypto from 'crypto';

// ---- ECDSA P-256 over a precomputed digest (Node's crypto always hashes first; KMS receives only the digest) ----
const P = BigInt('0xffffffff00000001000000000000000000000000ffffffffffffffffffffffff');
const N = BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
const A = P - 3n;
const G = { x: BigInt('0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296'), y: BigInt('0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5') };
type Pt = { x: bigint; y: bigint } | null;
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
function inv(a: bigint, m: bigint): bigint {
  let [o, r, s, t] = [mod(a, m), m, 1n, 0n];
  while (r) {
    const q = o / r;
    [o, r] = [r, o - q * r];
    [s, t] = [t, s - q * t];
  }
  return mod(s, m);
}
function add(p: Pt, q: Pt): Pt {
  if (!p) return q;
  if (!q) return p;
  if (p.x === q.x && mod(p.y + q.y, P) === 0n) return null;
  const l = p.x === q.x && p.y === q.y ? mod((3n * p.x * p.x + A) * inv(2n * p.y, P), P) : mod((q.y - p.y) * inv(q.x - p.x, P), P);
  const x = mod(l * l - p.x - q.x, P);
  return { x, y: mod(l * (p.x - x) - p.y, P) };
}
function mul(k: bigint, p: Pt): Pt {
  let r: Pt = null;
  let q = p;
  while (k > 0n) {
    if (k & 1n) r = add(r, q);
    q = add(q, q);
    k >>= 1n;
  }
  return r;
}
const big = (b: Buffer) => BigInt(`0x${b.toString('hex') || '0'}`);
const be32 = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex');

/** DER signature of a SHA-256 digest with private scalar d. */
function signDigest(d: bigint, digest: Buffer): Buffer {
  const z = big(digest);
  for (;;) {
    const k = mod(big(crypto.randomBytes(32)), N);
    if (!k) continue;
    const r = mod(mul(k, G)!.x, N);
    const s = mod(inv(k, N) * (z + r * d), N);
    if (!r || !s) continue;
    const int = (n: bigint) => {
      let b = be32(n);
      while (b.length > 1 && b[0] === 0 && !(b[1] & 0x80)) b = b.subarray(1);
      if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
      return Buffer.concat([Buffer.from([0x02, b.length]), b]);
    };
    const body = Buffer.concat([int(r), int(s)]);
    return Buffer.concat([Buffer.from([0x30, body.length]), body]);
  }
}

export interface FakeKmsKey {
  name: string;
  protectionLevel: string;
  algorithm: string;
  state: 'PENDING_GENERATION' | 'ENABLED' | 'DISABLED';
  polls: number;
  d: bigint;
  publicKey: crypto.KeyObject;
}

export interface FakeKms {
  fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<Response>;
  keys: Map<string, FakeKmsKey>;
  calls: Array<{ method: string; path: string }>;
  tokensIssued: number;
  /** Answer the next asymmetricSign with a signature by another key (a corrupted or wrong answer). */
  corruptNextSignature: boolean;
  serviceAccount: { type: string; client_email: string; private_key: string; token_uri: string };
}

export function createFakeKms(opts: { endpoint?: string; tokenUri?: string; pendingPolls?: number } = {}): FakeKms {
  const endpoint = opts.endpoint ?? 'https://kms.test';
  const tokenUri = opts.tokenUri ?? 'https://oauth.test/token';
  const sa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const serviceAccount = { type: 'service_account', client_email: 'qcmev-kms@example-project.iam.gserviceaccount.com', private_key: sa.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), token_uri: tokenUri };
  const tokens = new Set<string>();
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const kms: FakeKms = {
    keys: new Map(),
    calls: [],
    tokensIssued: 0,
    corruptNextSignature: false,
    serviceAccount,
    fetch: async (url, init) => {
      if (url === tokenUri) {
        const form = new URLSearchParams(init.body ?? '');
        const [h, c, s] = String(form.get('assertion') ?? '').split('.');
        const claims = JSON.parse(Buffer.from(c ?? '', 'base64url').toString() || '{}');
        const ok = form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer'
          && crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), sa.publicKey, Buffer.from(s ?? '', 'base64url'))
          && claims.iss === serviceAccount.client_email && claims.aud === tokenUri && claims.scope === 'https://www.googleapis.com/auth/cloudkms';
        if (!ok) return json(401, { error: 'invalid_grant' });
        const t = crypto.randomBytes(16).toString('hex');
        tokens.add(t);
        kms.tokensIssued++;
        return json(200, { access_token: t, expires_in: 3599, token_type: 'Bearer' });
      }
      if (!url.startsWith(endpoint)) return json(404, { error: { message: 'unknown host' } });
      if (!tokens.has(String(init.headers.Authorization ?? '').replace(/^Bearer /, ''))) return json(401, { error: { message: 'Request had invalid authentication credentials.' } });
      const u = new URL(url);
      const path = decodeURIComponent(u.pathname);
      kms.calls.push({ method: init.method, path });
      const body = init.body ? JSON.parse(init.body) : {};
      let m = path.match(/^\/v1\/(projects\/.+\/keyRings\/[^/]+)\/cryptoKeys$/);
      if (m && init.method === 'POST') {
        const id = u.searchParams.get('cryptoKeyId') ?? '';
        const name = `${m[1]}/cryptoKeys/${id}`;
        if (body.purpose !== 'ASYMMETRIC_SIGN' || body.versionTemplate?.algorithm !== 'EC_SIGN_P256_SHA256') return json(400, { error: { message: 'bad key template' } });
        const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
        const d = big(Buffer.from(privateKey.export({ format: 'jwk' }).d as string, 'base64url'));
        const pending = body.versionTemplate.protectionLevel === 'HSM' && (opts.pendingPolls ?? 1) > 0;
        kms.keys.set(`${name}/cryptoKeyVersions/1`, { name: `${name}/cryptoKeyVersions/1`, protectionLevel: body.versionTemplate.protectionLevel, algorithm: body.versionTemplate.algorithm, state: pending ? 'PENDING_GENERATION' : 'ENABLED', polls: 0, d, publicKey });
        return json(200, { name, purpose: 'ASYMMETRIC_SIGN' });
      }
      m = path.match(/^\/v1\/(.+\/cryptoKeyVersions\/\d+)(\/publicKey|:asymmetricSign)?$/);
      const key = m ? kms.keys.get(m[1]) : undefined;
      if (!m || !key) return json(404, { error: { message: 'NOT_FOUND' } });
      if (!m[2] && init.method === 'GET') {
        if (key.state === 'PENDING_GENERATION' && ++key.polls > (opts.pendingPolls ?? 1)) key.state = 'ENABLED';
        return json(200, { name: key.name, state: key.state, protectionLevel: key.protectionLevel, algorithm: key.algorithm });
      }
      if (!m[2] && init.method === 'PATCH') {
        if (u.searchParams.get('updateMask') !== 'state') return json(400, { error: { message: 'updateMask' } });
        key.state = body.state;
        return json(200, { name: key.name, state: key.state });
      }
      if (key.state !== 'ENABLED') return json(400, { error: { message: `key version is ${key.state}` } });
      if (m[2] === '/publicKey') return json(200, { pem: key.publicKey.export({ type: 'spki', format: 'pem' }).toString(), algorithm: key.algorithm, name: key.name });
      const digest = Buffer.from(String(body.digest?.sha256 ?? ''), 'base64');
      if (digest.length !== 32) return json(400, { error: { message: 'digest must be SHA-256' } });
      let d = key.d;
      if (kms.corruptNextSignature) {
        kms.corruptNextSignature = false;
        d = mod(d + 1n, N);
      }
      return json(200, { signature: signDigest(d, digest).toString('base64'), name: key.name });
    },
  };
  return kms;
}
