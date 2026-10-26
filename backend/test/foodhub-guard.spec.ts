import * as crypto from 'crypto';
import { hmacHex, verifySignedRequest } from '../src/integrations/foodhub/foodhub.guard';

const secret = crypto.randomBytes(32).toString('hex');
const previous = crypto.randomBytes(32).toString('hex');
const ids = ['foodhub', 'on2go_hub'];

/** Exactly what Food Hub's lib/foodhub/tenant.ts signContract() produces (timestamp in seconds) + X-Tenant-Id. */
function signContract(body: string, eventId: string, key: string, now = Date.now()): Record<string, string> {
  const ts = String(Math.floor(now / 1000));
  return {
    'x-integration-id': 'on2go_hub', 'x-event-id': eventId, 'x-timestamp': ts, 'idempotency-key': eventId,
    'x-signature': `sha256=${crypto.createHmac('sha256', key).update(`${ts}.${eventId}.${body}`).digest('hex')}`, 'x-tenant-id': 'takatak',
  };
}

describe('Food Hub HMAC guard (compatible with signContract)', () => {
  const body = JSON.stringify({ hello: 'world' });

  it('accepts a request signed by signContract', () => {
    expect(verifySignedRequest(signContract(body, 'evt_1', secret), body, [secret], ids)).toBeNull();
  });

  it('accepts a millisecond timestamp and integration id "foodhub"', () => {
    const ts = String(Date.now());
    const h = { 'x-integration-id': 'foodhub', 'x-tenant-id': 'takatak', 'x-event-id': 'evt_2', 'x-timestamp': ts, 'x-signature': `sha256=${hmacHex(secret, ts, 'evt_2', body)}` };
    expect(verifySignedRequest(h, body, [secret], ids)).toBeNull();
  });

  it('accepts the previous secret during a rotation', () => {
    expect(verifySignedRequest(signContract(body, 'evt_3', previous), body, [secret, previous], ids)).toBeNull();
  });

  it('refuses a changed body, a wrong secret, an old timestamp, an unknown integration, a bad tenant', () => {
    expect(verifySignedRequest(signContract(body, 'evt_4', secret), body + ' ', [secret], ids)).toBe('signature');
    expect(verifySignedRequest(signContract(body, 'evt_4', previous), body, [secret], ids)).toBe('signature');
    expect(verifySignedRequest(signContract(body, 'evt_4', secret, Date.now() - 6 * 60_000), body, [secret], ids)).toBe('timestamp window');
    expect(verifySignedRequest({ ...signContract(body, 'evt_4', secret), 'x-integration-id': 'x' }, body, [secret], ids)).toBe('integration id');
    expect(verifySignedRequest({ ...signContract(body, 'evt_4', secret), 'x-tenant-id': 'Bad Tenant' }, body, [secret], ids)).toBe('tenant id');
    expect(verifySignedRequest({ ...signContract(body, 'evt_4', secret), 'x-signature': 'sha256=zz' }, body, [secret], ids)).toBe('signature format');
  });
});
