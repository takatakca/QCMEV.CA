#!/usr/bin/env ts-node
/**
 * Takatak MEV — 12 INTERNAL SCENARIOS (these are NOT Revenu Québec's SW-77 test cases).
 * ────────────────────────────────────────────────────────────────────────────
 * The personalized SW-77 cases come with the partner documents; until then these scenarios exercise the staff API
 * end to end against the LOCAL SIMULATOR (or DEV once credentials exist): signatures, chain, numbering, taxes,
 * credit notes, reprints, post-invoice changes, offline mode and the user report.
 *
 * Run from backend/ (uses the backend's ts-node; no extra dependency, Node 20+ fetch):
 *   npx ts-node --transpile-only --project tsconfig.json ../scripts/run-test-cases.ts
 * Env: BACKEND_URL (default http://127.0.0.1:3001), QCMEV_ADMIN_USER, QCMEV_ADMIN_PASSWORD,
 *      QCMEV_SIM_CONTROL=1 to drive the simulator's mevDown switch (TC-008; SIMULATOR only).
 * The admin must exist (npm run seed:operator) and the device must have its certificate (POST /devices/:id/certificate).
 */
import * as crypto from 'crypto';

const BASE = (process.env.BACKEND_URL ?? 'http://127.0.0.1:3001').replace(/\/$/, '');
const USER = process.env.QCMEV_ADMIN_USER ?? '';
const PASS = process.env.QCMEV_ADMIN_PASSWORD ?? '';
const SIM = process.env.QCMEV_SIM_CONTROL === '1';
const FIRST_PRECED = '='.repeat(88);

let token = '';
const results: Array<{ id: string; name: string; status: 'PASS' | 'FAIL'; error?: string }> = [];

async function api<T = any>(method: string, path: string, body?: unknown, expect = [200, 201]): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!expect.includes(res.status)) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 400)}`);
  return data as T;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function run(id: string, name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${id}  ${name} ... `);
  try {
    await fn();
    console.log('PASS');
    results.push({ id, name, status: 'PASS' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`FAIL — ${msg}`);
    results.push({ id, name, status: 'FAIL', error: msg });
  }
}

/** Taxes as QCMEV must compute them: each tax rounded half-up on its own base. */
function taxes(baseCents: number) {
  const r = (num: number, den: number) => Math.sign(baseCents) * Math.floor((Math.abs(baseCents) * num + den / 2) / den);
  return { tps: r(5, 100), tvq: r(9975, 100000) };
}

function checkSigned(tx: any) {
  assert(typeof tx.signature === 'string' && tx.signature.length === 88, `signature must be 88 characters (got ${tx.signature?.length})`);
  assert(typeof tx.previousSignature === 'string' && tx.previousSignature.length === 88, 'previous signature must be 88 characters');
  assert(/^\d{14}$/.test(tx.datTrans), 'datTrans must be AAAAMMJJhhmmss');
  assert(['-04:00', '-05:00'].includes(tx.utcOffset), 'utc must be -04:00 or -05:00');
  assert(tx.totalCents === tx.subtotalCents + tx.tpsCents + tx.tvqCents, 'apresTax must equal avantTax + TPS + TVQ');
}

const item = (description: string, unitPriceCents: number, tax = 'FP', quantity = '1') => ({ description, quantity, unitPriceCents, tax });

async function sale(deviceId: string, items: any[], paymentMode = 'ARG', extra: Record<string, unknown> = {}) {
  return api('POST', '/transactions', { deviceId, items, paymentMode, serviceType: 'CMP', ...extra });
}

async function main() {
  console.log('\nTakatak MEV — internal scenarios (not SW-77)');
  console.log(`  backend: ${BASE}   date: ${new Date().toISOString()}\n`);
  if (!USER || !PASS) throw new Error('QCMEV_ADMIN_USER and QCMEV_ADMIN_PASSWORD are required');
  token = (await api('POST', '/auth/login', { username: USER, password: PASS }, [200])).accessToken;
  const devices = await api<any[]>('GET', '/devices');
  const device = devices.find((d) => d.mevDeviceId);
  assert(device, 'no certified device: run POST /api/devices/:id/certificate first');
  const deviceId = device.id as string;
  const signed: any[] = [];

  await run('TC-001', 'Sale, TPS + TVQ, cash', async () => {
    const tx = await sale(deviceId, [item('Poutine', 1299, 'FP', '2')]);
    checkSigned(tx);
    const t = taxes(2598);
    assert(tx.subtotalCents === 2598 && tx.tpsCents === t.tps && tx.tvqCents === t.tvq, `taxes ${tx.tpsCents}/${tx.tvqCents} != ${t.tps}/${t.tvq}`);
    assert(tx.mevStatus === 'ACCEPTED', `mevStatus ${tx.mevStatus}`);
    assert(tx.mevTransactionNumber, 'MEV transaction number missing');
    assert(tx.receipt.mentions.includes('PAIEMENT REÇU'), 'mention PAIEMENT REÇU missing');
    assert(tx.receipt.qr.svg.includes('<svg'), 'QR SVG missing');
    signed.push(tx);
  });

  await run('TC-002', 'Sale, TPS only (F), credit card', async () => {
    const tx = await sale(deviceId, [item('Service', 10000, 'F')], 'CRE');
    checkSigned(tx);
    assert(tx.tpsCents === 500 && tx.tvqCents === 0, 'code F: TPS only');
    signed.push(tx);
  });

  await run('TC-003', 'Sale, TVQ only (P), debit card', async () => {
    const tx = await sale(deviceId, [item('Article', 2500, 'P')], 'DEB');
    checkSigned(tx);
    assert(tx.tpsCents === 0 && tx.tvqCents === taxes(2500).tvq, 'code P: TVQ only');
    signed.push(tx);
  });

  await run('TC-004', 'Sale not taxable (NON)', async () => {
    const tx = await sale(deviceId, [item('Consigne', 500, 'NON')]);
    checkSigned(tx);
    assert(tx.tpsCents === 0 && tx.tvqCents === 0, 'NON: no tax');
    signed.push(tx);
  });

  let creditTarget: any;
  await run('TC-005', 'Full credit note (negative amounts, referenced)', async () => {
    creditTarget = await sale(deviceId, [item('Burger', 1500), item('Frites', 450)], 'CRE');
    const cn = await api('POST', `/transactions/${creditTarget.id}/credit-note`, { full: true, reason: 'TC-005' });
    checkSigned(cn);
    assert(cn.documentKind === 'CREDIT_NOTE' && cn.transactionType === 'RFER', 'credit note must be RFER / CREDIT_NOTE');
    assert(cn.subtotalCents === -creditTarget.subtotalCents && cn.tpsCents === -creditTarget.tpsCents && cn.tvqCents === -creditTarget.tvqCents, 'amounts must be the exact negatives');
    assert(cn.relatedTransactionId === creditTarget.id, 'reference to the original missing');
    assert(cn.receipt.mentions.includes('NOTE DE CRÉDIT'), 'mention NOTE DE CRÉDIT missing');
    assert(cn.mevStatus === 'ACCEPTED', `mevStatus ${cn.mevStatus}`);
    signed.push(creditTarget, cn);
    await api('POST', `/transactions/${creditTarget.id}/credit-note`, { full: true }, [400]);
  });

  await run('TC-006', '$0 receipt must use AUC (aucun paiement)', async () => {
    await sale(deviceId, [item('Café offert', 0)], 'ARG', {}).then(() => { throw new Error('ARG accepted for $0'); }, (e) => assert(String(e.message).includes('422'), 'expected 422'));
    const tx = await sale(deviceId, [item('Café offert', 0)], 'AUC');
    checkSigned(tx);
    assert(tx.totalCents === 0 && tx.paymentMode === 'AUC', '$0 with AUC');
    signed.push(tx);
  });

  await run('TC-007', 'E-commerce sale refuses cash; card accepted (commerElectr O)', async () => {
    await sale(deviceId, [item('Commande web', 2000)], 'ARG', { ecommerce: true }).then(() => { throw new Error('cash accepted'); }, (e) => assert(String(e.message).includes('422'), 'expected 422'));
    const tx = await sale(deviceId, [item('Commande web', 2000)], 'CRE', { ecommerce: true, serviceType: 'LVR' });
    checkSigned(tx);
    assert(tx.ecommerce === true, 'ecommerce flag');
    signed.push(tx);
  });

  await run('TC-008', 'Offline: MEV-WEB down → signed locally, queued, then sent in a batch', async () => {
    if (!SIM) throw new Error('needs QCMEV_SIM_CONTROL=1 (simulator)');
    await api('POST', '/mev-simulator/_control', { mevDown: true });
    try {
      const a = await sale(deviceId, [item('Hors ligne A', 1000)]);
      const b = await sale(deviceId, [item('Hors ligne B', 1100)]);
      checkSigned(a); checkSigned(b);
      assert(a.mevStatus === 'OFFLINE_PENDING' && b.mevStatus === 'OFFLINE_PENDING', `expected OFFLINE_PENDING, got ${a.mevStatus}/${b.mevStatus}`);
      assert(a.receipt.mentions.includes('PROBLÈME DE COMMUNICATION'), 'offline mention missing');
      const st = await api('GET', `/devices/${deviceId}/offline-status`);
      assert(st.offlineMode === true && st.pendingCount >= 2, 'device must be in offline mode with 2+ queued');
      signed.push(a, b);
      await api('POST', '/mev-simulator/_control', { mevDown: false });
      const flush = await api('POST', `/devices/${deviceId}/flush-queue`);
      assert(flush.accepted >= 2 && flush.pendingCount === 0 && flush.offlineMode === false, `flush ${JSON.stringify(flush)}`);
      const a2 = await api('GET', `/transactions/${a.id}`);
      assert(a2.mevStatus === 'ACCEPTED' && a2.mevTransactionNumber && a2.noTrans === a.noTrans, 'after flush: same noTrans, accepted, MEV number');
    } finally {
      await api('POST', '/mev-simulator/_control', { mevDown: false });
    }
  });

  await run('TC-009', 'Post-invoice price change → credit note + new receipt, both referenced', async () => {
    const tx = await sale(deviceId, [item('Article prix modifié', 5000)]);
    const r = await api('POST', `/transactions/${tx.id}/items/${tx.items[0].id}/price`, { newUnitPriceCents: 4500, reason: 'rabais caisse' });
    assert(r.creditNote.subtotalCents === -5000 && r.creditNote.relatedTransactionId === tx.id, 'credit note for the old line');
    assert(r.replacement.subtotalCents === 4500 && r.replacement.relatedTransactionId === tx.id, 'new receipt at the new price');
    const mods = await api<any[]>('GET', `/transactions/${tx.id}/modifications`);
    assert(mods.length >= 2, 'modification records');
    signed.push(tx, r.creditNote, r.replacement);
  });

  await run('TC-010', 'Post-invoice item removal → credit note for that item', async () => {
    const tx = await sale(deviceId, [item('Item A', 2000), item('Item B', 1000)]);
    const cn = await api('POST', `/transactions/${tx.id}/items/${tx.items[1].id}/remove`, { reason: 'non disponible' });
    assert(cn.subtotalCents === -1000 && cn.documentKind === 'CREDIT_NOTE', 'credit note of the removed item');
    const orig = await api('GET', `/transactions/${tx.id}`);
    assert(orig.status === 'PARTIALLY_CREDITED', `original status ${orig.status}`);
    signed.push(tx, cn);
  });

  await run('TC-011', 'Reproduction (RPR) and duplicate (DUP) are transmitted', async () => {
    const tx = await sale(deviceId, [item('Item reçu', 1500)]);
    const rpr = await api('POST', `/transactions/${tx.id}/reprint`, { mode: 'RPR' });
    const dup = await api('POST', `/transactions/${tx.id}/reprint`, { mode: 'DUP' });
    assert(rpr.printMode === 'RPR' && rpr.receipt.mentions.includes('REPRODUCTION'), 'RPR mention');
    assert(dup.printMode === 'DUP' && dup.receipt.mentions.includes('***COPIE DU COMMERÇANT***') && dup.receipt.mentions.includes('NE PAS REMETTRE AU CLIENT'), 'DUP mentions');
    assert(rpr.mevStatus === 'ACCEPTED' && dup.mevStatus === 'ACCEPTED', 'both transmitted and accepted');
    assert(rpr.noTrans !== tx.noTrans && dup.relatedTransactionId === tx.id, 'each copy is its own referenced transaction');
    signed.push(tx, rpr, dup);
  });

  await run('TC-012', 'User report (DOC RUT) transmitted when displayed', async () => {
    const year = new Date().getFullYear();
    const r = await api('POST', '/reports/user-report', { year });
    assert(r.mevStatus === 'ACCEPTED' && r.mevReportNumber && r.transmitted === true, `report ${r.mevStatus}`);
    assert(r.totalTransactions > 0, 'the report counts this year\'s receipts');
    const shown = ((r.display?.lines ?? []) as string[]).join('\n');
    for (const s of ["RAPPORT DE L'UTILISATEUR", 'No TPS', 'No TVQ', 'Utilisateur', 'Dernier document produit', "Identifiant de l'appareil", 'Identifiant du SEV', 'Version du SEV', 'Connexion au compte', 'Rapport produit le', '[CODE QR]']) {
      assert(shown.includes(s), `the displayed report shows « ${s} »`);
    }
    assert(!/avantTax|apresTax/.test(shown), 'the sales summary is transmitted, never displayed');
  });

  // Chain check across everything signed above (single device): each preced = the previous signature.
  await run('CHAIN', 'Signature chain and per-day numbering on the device', async () => {
    const all = await api<any[]>('GET', '/transactions?take=200');
    const mine = all.filter((t) => t.deviceId === deviceId).sort((a, b) => a.deviceSeq - b.deviceSeq);
    assert(mine.length >= signed.length, 'all transactions listed');
    for (let i = 0; i < mine.length; i++) {
      const expected = i === 0 ? (mine[0].deviceSeq === 1 ? FIRST_PRECED : mine[0].previousSignature) : mine[i - 1].signature;
      assert(mine[i].previousSignature === expected, `chain broken at deviceSeq ${mine[i].deviceSeq}`);
    }
    const keys = new Set(mine.map((t) => `${t.civilDate}|${t.noTrans}`));
    assert(keys.size === mine.length, 'noTrans must be unique per device per civil day');
    const h = crypto.createHash('sha256').update(mine.map((t) => t.signature).join('')).digest('hex').slice(0, 12);
    console.log(`\n       (${mine.length} transactions, chain fingerprint ${h})`);
  });

  const passed = results.filter((r) => r.status === 'PASS').length;
  console.log(`\nResults: ${passed} passed, ${results.length - passed} failed out of ${results.length}`);
  console.log('Reminder: these are internal scenarios against our own simulator, not Revenu Québec\'s SW-77 cases.\n');
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => {
  console.error(`\nUnexpected error: ${e instanceof Error ? e.message : e}`);
  process.exit(2);
});
