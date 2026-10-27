/**
 * The two global rate-limit tiers (ThrottlerModule in app.module.ts): 'short' (per second) and 'medium' (per minute),
 * per client IP, per tenant on the Food Hub routes. Limits: QCMEV_RATE_LIMIT_PER_SECOND / QCMEV_RATE_LIMIT_PER_MINUTE.
 */
export const SKIP_ALL_THROTTLES = { short: true, medium: true };

/** Food Hub integration, per tenant: bursts of 20 requests a second, 1200 a minute. */
export const FOODHUB_THROTTLE = { short: { limit: 20, ttl: 1_000 }, medium: { limit: 1_200, ttl: 60_000 } };

/** Login: 10 attempts a minute per IP. */
export const LOGIN_THROTTLE = { medium: { limit: 10, ttl: 60_000 } };

/** Public operator registration: 5 a minute per IP. */
export const REGISTER_THROTTLE = { medium: { limit: 5, ttl: 60_000 } };
