/**
 * Service-to-service authentication for Food Hub, compatible with Food Hub's lib/foodhub/tenant.ts signContract():
 *   X-Signature: sha256=hex(HMAC_SHA256(secret, `${X-Timestamp}.${X-Event-Id}.${rawBody}`))
 * - X-Timestamp in seconds (signContract) or milliseconds, 5-minute window;
 * - X-Integration-Id must be one of QCMEV_FOODHUB_INTEGRATION_IDS (default foodhub, on2go_hub);
 * - X-Tenant-Id is a slug; X-Event-Id is required;
 * - constant-time comparison; the current AND the previous secret are accepted (rotation).
 * No staff JWT on these calls.
 */
import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'crypto';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../../config/app-config';

export const SIGNATURE_WINDOW_MS = 5 * 60_000;

export interface SignedRequestInfo {
  tenantId: string;
  eventId: string;
  integrationId: string;
  idempotencyKey: string;
  rawBody: string;
  bodyHash: string;
}

export function hmacHex(secret: string, ts: string, eventId: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(`${ts}.${eventId}.${body}`).digest('hex');
}

/** Returns null when valid, else the reason (never echoed to the caller). */
export function verifySignedRequest(
  h: Record<string, string | undefined>,
  rawBody: string,
  secrets: string[],
  integrationIds: string[],
  now = Date.now(),
): string | null {
  const ts = h['x-timestamp'] ?? '';
  const eventId = h['x-event-id'] ?? '';
  const sig = (h['x-signature'] ?? '').replace(/^sha256=/, '');
  if (!integrationIds.includes(h['x-integration-id'] ?? '')) return 'integration id';
  if (!/^[a-z0-9][a-z0-9-]{1,39}$/.test(h['x-tenant-id'] ?? '')) return 'tenant id';
  if (!eventId || eventId.length > 128) return 'event id';
  if (!/^[a-f0-9]{64}$/.test(sig)) return 'signature format';
  let tsMs: number;
  if (/^\d{9,11}$/.test(ts)) tsMs = Number(ts) * 1000;
  else if (/^\d{12,14}$/.test(ts)) tsMs = Number(ts);
  else return 'timestamp format';
  if (Math.abs(now - tsMs) > SIGNATURE_WINDOW_MS) return 'timestamp window';
  const got = Buffer.from(sig, 'hex');
  for (const secret of secrets) {
    const want = Buffer.from(hmacHex(secret, ts, eventId, rawBody), 'hex');
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) return null;
  }
  return 'signature';
}

@Injectable()
export class FoodHubSignatureGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { rawBody?: Buffer; foodhub?: SignedRequestInfo }>();
    const h: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) h[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
    const rawBody = req.rawBody ? req.rawBody.toString('utf8') : '';
    const reason = verifySignedRequest(h, rawBody, this.cfg.foodhub.secrets, this.cfg.foodhub.integrationIds);
    if (reason) throw new UnauthorizedException({ statusCode: 401, error: 'invalid_signature' });
    req.foodhub = {
      tenantId: h['x-tenant-id'] as string,
      eventId: h['x-event-id'] as string,
      integrationId: h['x-integration-id'] as string,
      idempotencyKey: h['idempotency-key'] ?? '',
      rawBody,
      bodyHash: crypto.createHash('sha256').update(rawBody).digest('hex'),
    };
    return true;
  }
}
