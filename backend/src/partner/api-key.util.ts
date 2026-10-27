import * as crypto from 'crypto';

export const hashApiKey = (key: string) => crypto.createHash('sha256').update(key).digest('hex');

/** tkp_ + 40 url-safe random chars (240 bits) */
export function generateApiKey(): { key: string; prefix: string; keyHash: string } {
  const key = `tkp_${crypto.randomBytes(30).toString('base64url')}`;
  return { key, prefix: key.slice(0, 12), keyHash: hashApiKey(key) };
}
