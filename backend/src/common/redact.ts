/**
 * Redaction of sensitive values before anything is logged or stored in MevRequestLog / AuditLog.
 * Never log: authorization codes, NEQ, GST/QST numbers, mandatory-billing file numbers, CSRs, keys,
 * certificates, passwords, integration secrets.
 */

export const REDACTED = '[REDACTED]';

const SENSITIVE_KEYS = new Set(
  [
    'codautori', 'codeautorisation', 'authorizationcode', 'authorizationcodeenc', 'authcode',
    'notps', 'notvq', 'notax', 'nodossfo', 'filenumber', 'neq',
    'csr', 'csrpem', 'privatekey', 'privatekeypem', 'encryptedprivatekey', 'pemcertificate', 'certif', 'certifpsi',
    'password', 'passwordhash', 'adminpassword', 'secret', 'jwtsecret', 'x-signature', 'authorization',
  ],
);

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g;
const GST_NUMBER = /\b\d{9}\s?RT\s?\d{4}\b/gi;
const QST_NUMBER = /\b\d{10}\s?TQ\s?\d{4}\b/gi;

export function redactString(s: string): string {
  return s.replace(PEM_BLOCK, '[REDACTED PEM]').replace(GST_NUMBER, '[REDACTED TPS]').replace(QST_NUMBER, '[REDACTED TVQ]');
}

export function redact<T>(value: T, depth = 0): T {
  if (depth > 12) return REDACTED as unknown as T;
  if (typeof value === 'string') return redactString(value) as unknown as T;
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1)) as unknown as T;
  if (value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEYS.has(k.toLowerCase()) ? (v == null ? v : REDACTED) : redact(v, depth + 1);
  }
  return out as T;
}

/** A safe one-line description of an error (Prisma errors can echo query arguments). */
export function safeErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { name?: string; code?: string; message?: string };
    const code = e.code ? ` ${e.code}` : '';
    const firstLine = String(e.message ?? '').split('\n').find((l) => l.trim()) ?? '';
    const msg = /Invalid `.*` invocation/.test(firstLine) ? 'database call failed' : firstLine;
    return redactString(`${e.name ?? 'Error'}${code}: ${msg}`.slice(0, 300));
  }
  return redactString(String(err)).slice(0, 300);
}
