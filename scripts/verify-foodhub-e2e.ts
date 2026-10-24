#!/usr/bin/env ts-node
/**
 * Food Hub → QCMEV end-to-end check (contract foodhub.sale.v1), QCMEV side, against the LOCAL SIMULATOR.
 * It plays Food Hub's role (signed calls exactly like Food Hub's signContract + X-Tenant-Id) and then checks the
 * database: every signature verifies (ECDSA P-256) with the stored certificate, signa.preced chains, the internal
 * SHA-256 chain recomputes, amounts add up to the cent, and no identity value or secret reached any log.
 *
 * Normally started by tools/local-run/run-local.mjs (which creates the database, the secrets and the placeholders).
 * Run from backend/:  NODE_PATH=./node_modules npx ts-node --transpile-only --project tsconfig.json ../scripts/verify-foodhub-e2e.ts --phase=main
 * Env: BACKEND_URL, QCMEV_FOODHUB_SECRET, QCMEV_FOODHUB_SECRET_PREVIOUS, FOODHUB_TENANT, FOODHUB_LOCATIONS=A,B,
 *      DATABASE_URL, QCMEV_E2E_STATE (json file), QCMEV_E2E_REPORT (json file), QCMEV_E2E_FORBIDDEN (comma list of
 *      strings that must never appear in logs), BACKEND_LOG (backend stdout file).
 * LIMIT: this proves our own simulator only. Conformity is proven only in Revenu Québec's DEV / ESSAI environments.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-var-requires */
const { PrismaClient } = require('@prisma/client');

const BASE = (process.env.BACKEND_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const SECRET = process.env.QCMEV_FOODHUB_SECRET ?? '';
const SECRET_PREV = process.env.QCMEV_FOODHUB_SECRET_PREVIOUS ?? '';
const TENANT = process.env.FOODHUB_TENANT ?? 'takatak';
const [LOC_A, LOC_B] = (process.env.FOODHUB_LOCATIONS ?? 'E2E_A,E2E_B').split(',');
const STATE = process.env.QCMEV_E2E_STATE ?? '';
const REPORT = process.env.QCMEV_E2E_REPORT ?? '';
const FORBIDDEN = (process.env.QCMEV_E2E_FORBIDDEN ?? '').split(',').map((s) => s.trim()).filter((s) => s.length >= 6);
const BACKEND_LOG = process.env.BACKEND_LOG ?? '';
const PHASE = (process.argv.find((a) => a.startsWith('--phase=')) ?? '--phase=main').split('=')[1];
const RUN = process.env.QCMEV_E2E_RUN_ID ?? crypto.randomBytes(3).toString('hex');
const FIRST_PRECED = '='.repeat(88);
const PREFIX = '/api/v1/integrations/foodhub';

const checks: Array<{ id: string; name: string; ok: boolean; detail?: string }> = [];
function check(id: string, name: string, ok: boolean, detail?: string): void {
  checks.push({ id, name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${id}  ${name}${!ok && detail ? ` — ${detail}` : ''}`);
}

// ─── Helpers identical to QCMEV / Food Hub ─────────────────────────────────

function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const payloadHash = (b: Record<string, unknown>) => {
  const { payloadHash: _p, ...rest } = b;
  return sha256(canonicalJson(rest));
};
const halfUp = (c: number, num: number, den: number) => Math.sign(c) * Math.floor((Math.abs(c) * num + den / 2) / den);
const tps = (c: number) => halfUp(c, 5, 100);
const tvq = (c: number) => halfUp(c, 9975, 100000);

interface Call { status: number; body: any; eventId: string }

async function call(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, o: { secret?: string; eventId?: string; key?: string; tsSec?: number; integrationId?: string; tenant?: string } = {}): Promise<Call> {
  const raw = body === undefined ? '' : JSON.stringify(body);
  const key = o.key ?? (body?.saleKey as string) ?? (body?.creditKey as string) ?? (body?.printKey as string) ?? path;
  const eventId = o.eventId ?? `evt_${sha256(`${key}${body ? payloadHash(body) : ''}`).slice(0, 40)}`;
  const ts = String(o.tsSec ?? Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', o.secret ?? SECRET).update(`${ts}.${eventId}.${raw}`).digest('hex');
  const res = await fetch(`${BASE}${PREFIX}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Integration-Id': o.integrationId ?? 'foodhub',
      'X-Tenant-Id': o.tenant ?? TENANT,
      'X-Event-Id': eventId,
      'X-Timestamp': ts,
      'Idempotency-Key': eventId,
      'X-Signature': `sha256=${sig}`,
    },
    body: method === 'GET' ? undefined : raw,
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed, eventId };
}

async function simControl(body: Record<string, unknown>) {
  const r = await fetch(`${BASE}/api/mev-simulator/_control`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r.status !== 200) throw new Error(`simulator control failed: ${r.status}`);
}

const line = (description: string, unitPriceCents: number, quantity = '1', extra: Record<string, unknown> = {}) => ({
  description, quantity, unitPriceCents, totalCents: Math.round(unitPriceCents * Number(quantity)), taxCode: 'FP', activity: 'RES', ...extra,
});

function sale(o: {
  id: string; channel: string; serviceType: string; lines: any[]; loc?: string; ecommerce?: boolean; mode?: string; collectedBy?: string;
  deliveryCents?: number; serviceFeeCents?: number; discountCents?: number; tipCents?: number; gst?: number; qst?: number; referenceSaleKey?: string; model?: string;
}) {
  const model = o.model ?? (['website', 'phone', 'storefront'].includes(o.channel) ? 'direct' : 'stored');
  const linesTotal = o.lines.reduce((s, l) => s + l.totalCents + (l.modifiers ?? []).reduce((m: number, x: any) => m + x.totalCents, 0), 0);
  const subtotal = linesTotal + (o.serviceType === 'LVR' ? o.deliveryCents ?? 0 : 0) + (o.serviceFeeCents ?? 0) - (o.discountCents ?? 0);
  const gst = o.gst ?? tps(subtotal);
  const qst = o.qst ?? tvq(subtotal);
  const body: Record<string, unknown> = {
    schema: 'foodhub.sale.v1',
    tenantId: TENANT,
    locationId: o.loc ?? LOC_A,
    saleKey: `fh:${TENANT}:${model}:${o.channel}:${RUN}-${o.id}`,
    occurredAt: new Date().toISOString(),
    source: { model, channel: o.channel, orderId: `${RUN}-${o.id}`, externalOrderId: `EXT-${o.id}`, displayId: `${o.id.toUpperCase()}`, brand: 'Démo' },
    serviceType: o.serviceType,
    ecommerce: o.ecommerce ?? false,
    user: { id: 'staff-e2e', name: 'Staff E2E' },
    lines: o.lines,
    fees: { deliveryCents: o.deliveryCents ?? 0, serviceFeeCents: o.serviceFeeCents ?? 0 },
    discountCents: o.discountCents ?? 0,
    amounts: { subtotalCents: subtotal, gstCents: gst, qstCents: qst, totalCents: subtotal + gst + qst, tipCents: o.tipCents ?? 0 },
    payment: { mode: o.mode ?? 'AUT', collectedBy: o.collectedBy ?? 'platform' },
    receipt: { format: 'PAP', deliver: 'print' },
    testMode: false,
    ...(o.referenceSaleKey ? { referenceSaleKey: o.referenceSaleKey } : {}),
  };
  body.payloadHash = payloadHash(body);
  return body;
}

const enc = (k: string) => encodeURIComponent(k);
async function waitStatus(saleKey: string, want: string, timeoutMs = 45_000): Promise<any> {
  const until = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < until) {
    last = await call('GET', `/sales/${enc(saleKey)}`, undefined, { key: saleKey, eventId: `get_${crypto.randomBytes(6).toString('hex')}` });
    if (last.body?.status === want) return last.body;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return last?.body;
}

// ─── Phase main ────────────────────────────────────────────────────────────

async function phaseMain(): Promise<Record<string, unknown>> {
  const out: Record<string, any> = {};

  const h = await call('GET', '/health', undefined, { key: 'health' });
  check('H1', 'health: SIMULATOR, not certified, both locations ready', h.status === 200 && h.body.environment === 'SIMULATOR' && h.body.certified === false
    && h.body.locations?.length >= 2 && h.body.locations.every((l: any) => l.deviceReady && l.certReady && l.usersReady), JSON.stringify(h.body));

  // S1 — Uber delivery: courier tip $3 and platform delivery fee must be excluded.
  const s1 = sale({ id: 's1', channel: 'uber_eats', serviceType: 'LVT', mode: 'AUT', tipCents: 300, deliveryCents: 399,
    lines: [line('Trio poulet', 1899, '1', { modifiers: [{ description: 'Sauce BBQ', quantity: '1', unitPriceCents: 50, totalCents: 50 }] }), line('Liqueur', 250, '2')] });
  const r1 = await call('POST', '/sales', s1);
  out.s1 = r1.body;
  check('S1', 'Uber delivery → LVT accepted, courier tip and platform fee excluded, platform mention', r1.status === 200 && r1.body.status === 'accepted'
    && r1.body.amounts.tipCents === 0 && r1.body.warnings.includes('tipExcluded') && r1.body.warnings.includes('deliveryFeeExcluded')
    && r1.body.receipt.mentions.includes('COMMANDE PAR UNE PLATEFORME NUMÉRIQUE') && !r1.body.receipt.text80mm.some((l: string) => l.includes('Pourboire')), JSON.stringify(r1.body).slice(0, 400));

  // S8 — the same webhook delivered 3 times → one transaction, identical answers.
  const r1b = await call('POST', '/sales', s1);
  const r1c = await call('POST', '/sales', s1);
  check('S8', 'same sale delivered 3 times → 1 transaction, identical answers', r1b.status === 200 && r1c.status === 200
    && r1b.body.receipt.qcmevTransactionId === r1.body.receipt.qcmevTransactionId && r1c.body.receipt.renderHash === r1.body.receipt.renderHash
    && canonicalJson(r1c.body) === canonicalJson(r1.body), `${r1b.status} ${r1c.status}`);

  // S2 — DoorDash pickup with a restaurant promo, then an adjustment: credit note + new receipt with a reference.
  const s2 = sale({ id: 's2', channel: 'doordash', serviceType: 'LVT', discountCents: 300, lines: [line('Poutine', 1299), line('Burger', 1599)] });
  const r2 = await call('POST', '/sales', s2);
  const cn2body: Record<string, unknown> = { schema: 'foodhub.credit.v1', tenantId: TENANT, creditKey: `${s2.saleKey}:cn:1`, reason: 'adjusted', full: true, occurredAt: new Date().toISOString() };
  cn2body.payloadHash = payloadHash(cn2body);
  const cn2 = await call('POST', `/sales/${enc(s2.saleKey as string)}/credit-notes`, cn2body);
  const s2b = sale({ id: 's2-adj', channel: 'doordash', serviceType: 'LVT', lines: [line('Burger', 1599)], referenceSaleKey: s2.saleKey as string });
  s2b.saleKey = `${s2.saleKey}#2`;
  s2b.payloadHash = payloadHash(s2b);
  const r2b = await call('POST', '/sales', s2b);
  out.s2 = { sale: r2.body, credit: cn2.body, replacement: r2b.body };
  check('S2', 'DoorDash promo → sale (discount in avantTax), full credit note, new referenced receipt', r2.status === 200 && r2.body.status === 'accepted'
    && r2.body.amounts.subtotalCents === 2598 && cn2.status === 200 && cn2.body.status === 'accepted' && cn2.body.amounts.subtotalCents === -2598
    && cn2.body.receipt.mentions.includes('NOTE DE CRÉDIT') && r2b.status === 200 && r2b.body.status === 'accepted'
    && r2b.body.receipt.text80mm.some((l: string) => l.startsWith('Réf. : transaction')), `${r2.status}/${cn2.status}/${r2b.status} ${JSON.stringify(cn2.body).slice(0, 200)}`);

  // S3 — Skip failed order (tax 0 in the feed): Food Hub computes the taxes from the base; then a missing item.
  const s3 = sale({ id: 's3', channel: 'skip', serviceType: 'LVT', lines: [line('Shawarma', 1400), line('Baklava', 600)] });
  const r3 = await call('POST', '/sales', s3);
  const cn3body: Record<string, unknown> = { schema: 'foodhub.credit.v1', tenantId: TENANT, creditKey: `${s3.saleKey}:cn:1`, reason: 'missing_items', full: false,
    lines: [line('Baklava', 600)], amounts: { subtotalCents: 600 } };
  cn3body.payloadHash = payloadHash(cn3body);
  const cn3 = await call('POST', `/sales/${enc(s3.saleKey as string)}/credit-notes`, cn3body);
  check('S3', 'Skip failed order with computed taxes accepted; missing item → partial credit note', r3.status === 200 && r3.body.status === 'accepted'
    && r3.body.amounts.gstCents === 100 && r3.body.amounts.qstCents === 200 && !r3.body.warnings.includes('taxGap')
    && cn3.status === 200 && cn3.body.amounts.subtotalCents === -600 && cn3.body.amounts.gstCents === -30, `${JSON.stringify(cn3.body).slice(0, 300)}`);

  // S3b — the same with tax left at 0: QCMEV flags taxGap and the simulator refuses it (needs a human).
  const s3b = sale({ id: 's3b', channel: 'skip', serviceType: 'LVT', loc: LOC_B, gst: 0, qst: 0, lines: [line('Shawarma', 1400)] });
  const r3b = await call('POST', '/sales', s3b);
  check('S3b', 'tax 0 on a taxable order → taxGap warning, MEV rejection with error list', r3b.status === 200 && r3b.body.status === 'rejected'
    && r3b.body.warnings.includes('taxGap') && r3b.body.errors.some((e: any) => e.codRetour && e.mess), JSON.stringify(r3b.body).slice(0, 300));

  // S4 — phone pickup, pay at the counter in cash, $2 tip kept by the restaurant.
  const s4 = sale({ id: 's4', channel: 'phone', serviceType: 'CMP', mode: 'ARG', collectedBy: 'clover_tender', tipCents: 200, lines: [line('Pizza 12"', 1850)] });
  const r4 = await call('POST', '/sales', s4);
  out.s4 = r4.body;
  check('S4', 'phone pickup → CMP, ARG, pourb 2.00 outside apresTax', r4.status === 200 && r4.body.status === 'accepted' && r4.body.amounts.tipCents === 200
    && r4.body.amounts.totalCents === r4.body.amounts.subtotalCents + r4.body.amounts.gstCents + r4.body.amounts.qstCents
    && r4.body.receipt.text80mm.some((l: string) => l.startsWith('Pourboire')), JSON.stringify(r4.body).slice(0, 300));

  // S5 — website, own delivery, paid online; MEV-WEB down → offline_pending with a local QR, then the batch flush.
  await simControl({ mevDown: true });
  const s5 = sale({ id: 's5', channel: 'website', serviceType: 'LVR', ecommerce: true, mode: 'CRE', collectedBy: 'paylink', deliveryCents: 499, lines: [line('Combo famille', 4599)] });
  const r5 = await call('POST', '/sales', s5);
  await simControl({ mevDown: false });
  const r5done = await waitStatus(s5.saleKey as string, 'accepted');
  out.s5 = { offline: r5.body, after: r5done };
  check('S5', 'website LVR + ecommerce O + CRE; offline_pending with QR while MEV-WEB is down; accepted after the batch flush, same noTrans', r5.status === 200
    && r5.body.status === 'offline_pending' && r5.body.receipt.qr.svg.includes('<svg') && r5.body.receipt.mentions.some((m: string) => m.includes('HORS LIGNE'))
    && r5.body.amounts.subtotalCents === 4599 + 499 && r5done?.status === 'accepted' && r5done.receipt.noTrans === r5.body.receipt.noTrans
    && !!r5done.receipt.mevTransactionNumber, `${r5.body?.status} → ${r5done?.status}`);

  // S6 — the platform cancels after acceptance → full credit note.
  const s6 = sale({ id: 's6', channel: 'uber_eats', serviceType: 'LVT', loc: LOC_B, lines: [line('Wrap', 1250)] });
  const r6 = await call('POST', '/sales', s6);
  const cn6body: Record<string, unknown> = { schema: 'foodhub.credit.v1', tenantId: TENANT, creditKey: `${s6.saleKey}:cn:1`, reason: 'cancelled', full: true };
  cn6body.payloadHash = payloadHash(cn6body);
  const cn6 = await call('POST', `/sales/${enc(s6.saleKey as string)}/credit-notes`, cn6body);
  check('S6', 'cancel after acceptance → full credit note referencing the sale', r6.body?.status === 'accepted' && cn6.status === 200
    && cn6.body.amounts.totalCents === -r6.body.amounts.totalCents && cn6.body.receipt.text80mm.some((l: string) => l.includes(`transaction ${r6.body.receipt.noTrans} du`)), JSON.stringify(cn6.body).slice(0, 200));

  // S9 — civil date and time are local (America/Montreal), with the offset.
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Montreal', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()).replace(/-/g, '');
  check('S9', 'datTrans is local Montréal time (civil date = local date) with -04:00/-05:00', r4.body.receipt.datTrans.slice(0, 8) === local && ['-04:00', '-05:00'].includes(r4.body.receipt.utc), `${r4.body.receipt.datTrans} vs ${local}`);

  // S10 — $0 order → AUC.
  const s10 = sale({ id: 's10', channel: 'storefront', serviceType: 'CMP', mode: 'CRE', collectedBy: 'clover_tender', lines: [line('Café offert', 0)] });
  const r10 = await call('POST', '/sales', s10);
  check('S10', '$0 order → payment mode AUC', r10.status === 200 && r10.body.status === 'accepted' && r10.body.warnings.includes('paymentModeAUC') && r10.body.receipt.text80mm.some((l: string) => l.includes('Aucun paiement')), JSON.stringify(r10.body).slice(0, 200));

  // S11 — reprint (RPR) and merchant copy (DUP), both transmitted.
  const pr = async (mode: string, n: number) => {
    const b: Record<string, unknown> = { schema: 'foodhub.print.v1', tenantId: TENANT, printKey: `${s4.saleKey}:pr:${n}`, mode };
    b.payloadHash = payloadHash(b);
    return call('POST', `/sales/${enc(s4.saleKey as string)}/prints`, b);
  };
  const rpr = await pr('RPR', 1);
  const dup = await pr('DUP', 2);
  check('S11', 'RPR shows REPRODUCTION; DUP shows ***COPIE DU COMMERÇANT*** / NE PAS REMETTRE AU CLIENT; both accepted', rpr.body?.status === 'accepted'
    && rpr.body.receipt.mentions.includes('REPRODUCTION') && dup.body?.status === 'accepted' && dup.body.receipt.mentions.includes('***COPIE DU COMMERÇANT***')
    && dup.body.receipt.mentions.includes('NE PAS REMETTRE AU CLIENT'), `${rpr.status} ${dup.status}`);

  const g = await call('GET', `/sales/${enc(s4.saleKey as string)}`, undefined, { key: s4.saleKey as string, eventId: `get_${crypto.randomBytes(6).toString('hex')}` });
  check('G1', 'GET /sales/{saleKey} returns the receipt and its prints', g.status === 200 && g.body.receipt?.noTrans === r4.body.receipt.noTrans && g.body.prints?.length === 2, JSON.stringify(g.body).slice(0, 200));

  // Negative paths.
  const s4changed = { ...s4, lines: [line('Pizza 16"', 2450)] } as Record<string, unknown>;
  const am = { subtotalCents: 2450, gstCents: tps(2450), qstCents: tvq(2450), totalCents: 2450 + tps(2450) + tvq(2450), tipCents: 200 };
  s4changed.amounts = am;
  s4changed.payloadHash = payloadHash(s4changed);
  const n1 = await call('POST', '/sales', s4changed);
  check('N1', 'same saleKey, different payload → 409 idempotency_conflict', n1.status === 409 && n1.body.error === 'idempotency_conflict', `${n1.status}`);

  const s12 = sale({ id: 's12', channel: 'phone', serviceType: 'CMP', mode: 'DEB', collectedBy: 'clover_tender', lines: [line('Frites', 450)] });
  const n2 = await call('POST', '/sales', s12, { eventId: r4.eventId });
  check('N2', 'reused event id with another body → 409 replay_conflict', n2.status === 409 && n2.body.error === 'replay_conflict', `${n2.status}`);

  const n3 = await call('POST', '/sales', s12, { secret: 'f'.repeat(64) });
  check('N3', 'wrong secret → 401', n3.status === 401, `${n3.status}`);
  const n4 = await call('POST', '/sales', s12, { tsSec: Math.floor(Date.now() / 1000) - 600 });
  check('N4', 'timestamp older than 5 minutes → 401', n4.status === 401, `${n4.status}`);
  const n5 = await call('POST', '/sales', { schema: 'foodhub.sale.v1', tenantId: TENANT, lines: [] });
  check('N5', 'invalid payload → 422 with the field list', n5.status === 422 && Array.isArray(n5.body.errors) && n5.body.errors.some((e: any) => e.field === 'lines'), `${n5.status}`);
  const n6body = sale({ id: 'n6', channel: 'phone', serviceType: 'CMP', mode: 'ARG', collectedBy: 'cash', loc: 'NOPE', lines: [line('Frites', 450)] });
  const n6 = await call('POST', '/sales', n6body);
  check('N6', 'unknown location → 423 location_not_ready', n6.status === 423 && n6.body.error === 'location_not_ready', `${n6.status}`);
  const n7 = await call('GET', '/health', undefined, { key: 'health', secret: SECRET_PREV || SECRET });
  check('N7', 'previous secret still accepted (rotation)', !!SECRET_PREV && n7.status === 200, `${n7.status}`);
  const n8body = sale({ id: 'n8', channel: 'website', serviceType: 'LVR', ecommerce: true, mode: 'ARG', collectedBy: 'paylink', lines: [line('Frites', 450)] });
  const n8 = await call('POST', '/sales', n8body);
  check('N8', 'e-commerce sale paid "cash" → 422', n8.status === 422, `${n8.status}`);
  const n9body: Record<string, unknown> = { schema: 'foodhub.credit.v1', tenantId: TENANT, creditKey: `${s3.saleKey}:cn:2`, reason: 'refund', full: false, lines: [line('Shawarma', 1400), line('Extra', 900)] };
  n9body.payloadHash = payloadHash(n9body);
  const n9 = await call('POST', `/sales/${enc(s3.saleKey as string)}/credit-notes`, n9body);
  check('N9', 'credit larger than what remains → 422', n9.status === 422, `${n9.status} ${JSON.stringify(n9.body).slice(0, 150)}`);
  const n10 = await call('POST', '/sales', s12, { integrationId: 'someone_else' });
  check('N10', 'unknown X-Integration-Id → 401', n10.status === 401, `${n10.status}`);

  if (STATE) fs.writeFileSync(STATE, JSON.stringify({ s4, s4noTrans: r4.body.receipt.noTrans, s4tx: r4.body.receipt.qcmevTransactionId, run: RUN }));
  return out;
}

// ─── Phase after-restart ───────────────────────────────────────────────────

async function phaseAfterRestart(): Promise<Record<string, unknown>> {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  const again = await call('POST', '/sales', st.s4);
  check('R1', 'after a QCMEV restart, the same sale replays with the same noTrans and transaction', again.status === 200
    && again.body.receipt.noTrans === st.s4noTrans && again.body.receipt.qcmevTransactionId === st.s4tx, `${again.status} ${again.body?.receipt?.noTrans}`);
  const s13 = sale({ id: 's13', channel: 'phone', serviceType: 'CMP', mode: 'DEB', collectedBy: 'clover_tender', lines: [line('Frites', 450)] });
  const r13 = await call('POST', '/sales', s13);
  check('R2', 'new sale after the restart is accepted (simulator state and chain persisted)', r13.status === 200 && r13.body.status === 'accepted', JSON.stringify(r13.body).slice(0, 300));
  return { r13: r13.body };
}

// ─── Database and log checks ───────────────────────────────────────────────

async function dbChecks(): Promise<Record<string, unknown>> {
  const prisma = new PrismaClient();
  try {
    const txs = await prisma.transaction.findMany({ include: { operator: true, items: true }, orderBy: [{ deviceId: 'asc' }, { deviceSeq: 'asc' }] });
    const certs = await prisma.certificate.findMany({ where: { type: 'SEV' } });
    let sigOk = 0, chainOk = 0, hashOk = 0, amountsOk = 0;
    const bad: string[] = [];
    const byDevice = new Map<string, any[]>();
    for (const t of txs) byDevice.set(t.deviceId, [...(byDevice.get(t.deviceId) ?? []), t]);
    for (const [deviceId, list] of byDevice) {
      const cert = certs.filter((c: any) => c.deviceId === deviceId).sort((a: any, b: any) => +a.createdAt - +b.createdAt);
      let prevSig = FIRST_PRECED;
      let prevHash = '0'.repeat(64);
      for (const t of list) {
        const core = t.requestJson as any;
        const signedString = [core.noTrans, core.datTrans, core.mont.TPS, core.mont.TVQ, core.mont.apresTax, t.operator.noTPS, t.operator.noTVQ, core.modImpr, core.modTrans, core.signa.preced].join('');
        const c = cert.filter((x: any) => +x.createdAt <= +t.createdAt).pop() ?? cert[0];
        const pub = new crypto.X509Certificate(c.pemCertificate).publicKey;
        const verified = t.signature.length === 88 && crypto.verify('sha256', Buffer.from(signedString), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(t.signature, 'base64'));
        if (verified) sigOk++; else bad.push(`sig ${t.noTrans}`);
        if (t.previousSignature === prevSig && core.signa.preced === prevSig && core.signa.actu === t.signature) chainOk++; else bad.push(`chain ${t.deviceSeq}`);
        const h = sha256(`${prevHash}|${canonicalJson(core)}`);
        if (h === t.hashChain) hashOk++; else bad.push(`hash ${t.deviceSeq}`);
        const itemsSum = t.items.reduce((s: number, i: any) => s + i.totalCents, 0);
        if (t.totalCents === t.subtotalCents + t.tpsCents + t.tvqCents && itemsSum === t.subtotalCents) amountsOk++; else bad.push(`amounts ${t.noTrans}`);
        prevSig = t.signature;
        prevHash = t.hashChain;
      }
    }
    check('D1', `every signature is 88 characters and verifies with the stored certificate (${sigOk}/${txs.length})`, sigOk === txs.length, bad.slice(0, 5).join(', '));
    check('D2', `signa.preced chains on every device, first = 88 "=" (${chainOk}/${txs.length})`, chainOk === txs.length, bad.slice(0, 5).join(', '));
    check('D3', `internal SHA-256 chain recomputes from the start (${hashOk}/${txs.length})`, hashOk === txs.length);
    check('D4', `apresTax = avantTax + TPS + TVQ and items = avantTax for every transaction (${amountsOk}/${txs.length})`, amountsOk === txs.length);
    const keys = new Set(txs.map((t: any) => `${t.deviceId}|${t.civilDate}|${t.noTrans}`));
    check('D5', 'noTrans unique per device per civil day', keys.size === txs.length);

    const ext = await prisma.externalSale.findMany({ where: { tenantId: TENANT, saleKey: { contains: RUN } } });
    const extTx = await prisma.transaction.findMany({ where: { id: { in: ext.map((e: any) => e.transactionId).filter(Boolean) } } });
    const byId = new Map(extTx.map((t: any) => [t.id, t]));
    const sales = ext.filter((e: any) => e.kind === 'SALE');
    const credits = ext.filter((e: any) => e.kind === 'CREDIT_NOTE');
    const prints = ext.filter((e: any) => e.kind === 'PRINT');
    const tipped = extTx.filter((t: any) => t.tipCents);
    const s4tx = sales.find((e: any) => e.saleKey.endsWith(`${RUN}-s4`));
    check('D6', `counts: 9 receipts, 3 credit notes, 2 prints (got ${sales.length}/${credits.length}/${prints.length})`, sales.length === 9 && credits.length === 3 && prints.length === 2);
    check('D7', 'pourb only on S4 (and its two copies)', tipped.length === 3 && tipped.every((t: any) => t.id === s4tx?.transactionId || t.relatedTransactionId === s4tx?.transactionId));
    check('D8', 'credit notes: negative amounts and a reference', credits.every((e: any) => { const t: any = byId.get(e.transactionId); return t && t.totalCents < 0 && t.relatedTransactionId; }));
    const typ = (suffix: string) => (byId.get(sales.find((e: any) => e.saleKey.endsWith(`${RUN}-${suffix}`))?.transactionId) as any)?.serviceType;
    check('D9', 'typServ: S1 LVT, S4 CMP, S5 LVR', typ('s1') === 'LVT' && typ('s4') === 'CMP' && typ('s5') === 'LVR');
    const s1tx: any = byId.get(sales.find((e: any) => e.saleKey.endsWith(`${RUN}-s1`))?.transactionId);
    const s1items = s1tx ? await prisma.transactionItem.findMany({ where: { transactionId: s1tx.id } }) : [];
    check('D10', 'S1 has no courier tip and no platform delivery fee line', !!s1tx && !s1tx.tipCents && !s1items.some((i: any) => /livraison/i.test(i.description)));

    const logs = JSON.stringify(await prisma.mevRequestLog.findMany()) + JSON.stringify(await prisma.auditLog.findMany());
    const stdout = BACKEND_LOG && fs.existsSync(BACKEND_LOG) ? fs.readFileSync(BACKEND_LOG, 'utf8') : '';
    const leaks = FORBIDDEN.filter((f) => logs.includes(f) || stdout.includes(f));
    check('D11', `no authorization code, NEQ, TPS/TVQ or file number, secret or key in MevRequestLog, AuditLog or stdout (${FORBIDDEN.length} values checked)`, FORBIDDEN.length > 0 && leaks.length === 0, leaks.length ? `${leaks.length} leaked value(s)` : '');
    check('D12', 'no PEM block in MevRequestLog, AuditLog or stdout', !/-----BEGIN /.test(logs) && !/-----BEGIN /.test(stdout));
    return { transactions: txs.length, devices: byDevice.size, receipts: sales.length, creditNotes: credits.length, prints: prints.length };
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  console.log(`\nFood Hub → QCMEV e2e (${PHASE}), backend ${BASE}, run ${RUN}\n`);
  if (!SECRET) throw new Error('QCMEV_FOODHUB_SECRET is required');
  const data = PHASE === 'after-restart' ? await phaseAfterRestart() : await phaseMain();
  const db = PHASE === 'after-restart' ? {} : await dbChecks();
  const failed = checks.filter((c) => !c.ok);
  const report = { phase: PHASE, run: RUN, at: new Date().toISOString(), passed: checks.length - failed.length, failed: failed.length, checks, db, samples: data };
  if (REPORT) {
    const prev = fs.existsSync(REPORT) ? JSON.parse(fs.readFileSync(REPORT, 'utf8')) : {};
    fs.writeFileSync(REPORT, JSON.stringify({ ...prev, [PHASE]: report }, null, 2));
  }
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed (${PHASE}). Proves our simulator only, not Revenu Québec conformity.\n`);
  if (failed.length) process.exit(1);
}

main().catch((e) => {
  console.error(`\nUnexpected error: ${e instanceof Error ? e.stack : e}`);
  process.exit(2);
});
