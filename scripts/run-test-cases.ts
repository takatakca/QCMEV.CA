#!/usr/bin/env ts-node
/**
 * SW-77 Test Case Runner for Takatak MEV
 * ────────────────────────────────────────────────────────────────────────────
 * Exercises all 12 mandatory test cases against the MEV simulator or a real
 * MEV-WEB environment.
 *
 * Usage:
 *   npx ts-node scripts/run-test-cases.ts [--env SIMULATOR|DEVELOPMENT|TESTING]
 *
 * Requirements:
 *   - Backend must be running at http://localhost:3001
 *   - A valid JWT token must be set in TAKATAK_TOKEN env var
 *     (obtain via POST /api/auth/login)
 *
 * Test cases per SW-77:
 *   TC-001  Normal sale (ADD) with TPS+TVQ
 *   TC-002  Sale with TPS only
 *   TC-003  Sale with TVQ only
 *   TC-004  Tax-exempt sale
 *   TC-005  Refund/credit note
 *   TC-006  No-sale transaction
 *   TC-007  Cancellation of a prior transaction
 *   TC-008  Offline mode — queue and batch submit
 *   TC-009  Post-invoice price modification (SW-76 §4.6)
 *   TC-010  Post-invoice item removal (SW-76 §4.6)
 *   TC-011  Duplicate receipt request
 *   TC-012  Annual user report (DOC submission)
 */

import axios, { AxiosInstance } from 'axios';

const BASE_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';
const TOKEN    = process.env.TAKATAK_TOKEN ?? '';

if (!TOKEN) {
  console.error('❌  TAKATAK_TOKEN env var required. Get it via POST /api/auth/login');
  process.exit(1);
}

const api: AxiosInstance = axios.create({
  baseURL: `${BASE_URL}/api`,
  headers: { Authorization: `Bearer ${TOKEN}` },
});

// ─── Helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const results: Array<{ id: string; name: string; status: 'PASS' | 'FAIL'; error?: string }> = [];

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

async function runTest(id: string, name: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${id}  ${name} ... `);
  try {
    await fn();
    console.log('✅ PASS');
    passed++;
    results.push({ id, name, status: 'PASS' });
  } catch (err: any) {
    const msg = err.response?.data?.message ?? err.message ?? String(err);
    console.log(`❌ FAIL — ${msg}`);
    failed++;
    results.push({ id, name, status: 'FAIL', error: msg });
  }
}

// ─── Get device id ───────────────────────────────────────────────────────────

async function getFirstDevice(): Promise<string> {
  const res = await api.get('/devices');
  if (!res.data.length) throw new Error('No devices registered. Register a device first.');
  return res.data[0].id;
}

// ─── Test Cases ──────────────────────────────────────────────────────────────

async function main() {
  console.log('\n🧪  Takatak MEV — SW-77 Test Cases');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`   Backend: ${BASE_URL}`);
  console.log(`   Date:    ${new Date().toISOString()}`);
  console.log('───────────────────────────────────────────────────────\n');

  const deviceId = await getFirstDevice();

  // TC-001: Normal sale ADD with TPS+TVQ ─────────────────────────────────────
  await runTest('TC-001', 'Normal sale (ADD) — TPS + TVQ', async () => {
    const res = await api.post('/transactions', {
      deviceId,
      items: [{ description: 'Repas', quantity: 2, unitPrice: 15.00, taxCode: 'FP' }],
      paymentMode: 'CASH',
    });
    const tx = res.data;
    assert(tx.id, 'Transaction ID missing');
    assert(tx.transactionType === 'ADDITION', 'Wrong transaction type');
    assert(Number(tx.tpsAmount) > 0, 'TPS must be > 0');
    assert(Number(tx.tvqAmount) > 0, 'TVQ must be > 0');
    assert(tx.mevSubmissionStatus, 'MEV submission status missing');
  });

  // TC-002: Sale TPS only ─────────────────────────────────────────────────────
  await runTest('TC-002', 'Sale — TPS only (code F)', async () => {
    const res = await api.post('/transactions', {
      deviceId,
      items: [{ description: 'Service', quantity: 1, unitPrice: 100.00, taxCode: 'F' }],
      paymentMode: 'CREDIT_CARD',
    });
    const tx = res.data;
    assert(Number(tx.tpsAmount) > 0, 'TPS must be > 0');
    assert(Number(tx.tvqAmount) === 0, 'TVQ must be 0 for code F');
  });

  // TC-003: Sale TVQ only ─────────────────────────────────────────────────────
  await runTest('TC-003', 'Sale — TVQ only (code P)', async () => {
    const res = await api.post('/transactions', {
      deviceId,
      items: [{ description: 'Livre', quantity: 1, unitPrice: 25.00, taxCode: 'P' }],
      paymentMode: 'CASH',
    });
    const tx = res.data;
    assert(Number(tx.tpsAmount) === 0, 'TPS must be 0 for code P');
    assert(Number(tx.tvqAmount) > 0, 'TVQ must be > 0');
  });

  // TC-004: Exempt sale ───────────────────────────────────────────────────────
  await runTest('TC-004', 'Tax-exempt sale (no tax code)', async () => {
    const res = await api.post('/transactions', {
      deviceId,
      items: [{ description: 'Médicament', quantity: 1, unitPrice: 50.00, taxCode: '' }],
      paymentMode: 'CASH',
    });
    const tx = res.data;
    assert(Number(tx.tpsAmount) === 0, 'TPS must be 0 for exempt');
    assert(Number(tx.tvqAmount) === 0, 'TVQ must be 0 for exempt');
  });

  // TC-005: Refund ───────────────────────────────────────────────────────────
  await runTest('TC-005', 'Refund / credit note (RFC)', async () => {
    // First create a sale to refund
    const saleRes = await api.post('/transactions', {
      deviceId,
      items: [{ description: 'Article retourné', quantity: 1, unitPrice: 30.00, taxCode: 'FP' }],
      paymentMode: 'CASH',
    });
    // Then refund it
    const res = await api.post('/transactions', {
      deviceId,
      items: [{ description: 'Article retourné', quantity: -1, unitPrice: 30.00, taxCode: 'FP' }],
      paymentMode: 'CASH',
      originalTransactionId: saleRes.data.id,
      transactionType: 'REFUND_CREDIT',
    });
    assert(res.data.id, 'Refund transaction ID missing');
  });

  // TC-006: No-sale ──────────────────────────────────────────────────────────
  await runTest('TC-006', 'No-sale transaction (SOU)', async () => {
    const res = await api.post('/transactions', {
      deviceId,
      items: [],
      paymentMode: 'CASH',
      transactionType: 'NO_SALE',
    });
    assert(res.data.id, 'No-sale transaction ID missing');
    assert(Number(res.data.totalAmount) === 0, 'No-sale total must be 0');
  });

  // TC-007: Cancellation ─────────────────────────────────────────────────────
  await runTest('TC-007', 'Transaction cancellation (ANN)', async () => {
    const saleRes = await api.post('/transactions', {
      deviceId,
      items: [{ description: 'Item à annuler', quantity: 1, unitPrice: 20.00, taxCode: 'FP' }],
      paymentMode: 'CASH',
    });
    const cancelRes = await api.post(`/transactions/${saleRes.data.id}/cancel`);
    assert(cancelRes.data.id, 'Cancellation transaction missing');
  });

  // TC-008: Offline queue ────────────────────────────────────────────────────
  await runTest('TC-008', 'Offline mode — queue then flush', async () => {
    // Check offline status
    const statusRes = await api.get(`/devices/${deviceId}/offline-status`);
    const beforeCount = statusRes.data.pendingCount ?? 0;

    // Flush queue
    const flushRes = await api.post(`/devices/${deviceId}/flush-queue`);
    assert(flushRes.data !== undefined, 'Flush response missing');
    console.log(`\n       (queue had ${beforeCount} items before flush)`);
  });

  // TC-009: Post-invoice price mod ───────────────────────────────────────────
  await runTest('TC-009', 'Post-invoice price modification (SW-76 §4.6)', async () => {
    const saleRes = await api.post('/transactions', {
      deviceId,
      items: [{ description: 'Article prix modifié', quantity: 1, unitPrice: 50.00, taxCode: 'FP' }],
      paymentMode: 'CASH',
    });
    const tx = saleRes.data;
    const itemId = tx.items[0]?.id;
    assert(itemId, 'Item ID missing from transaction');

    const modRes = await api.post(`/transactions/${tx.id}/items/${itemId}/price`, {
      newUnitPrice: 45.00,
      reason: 'Rabais accordé en caisse',
    });
    assert(modRes.data.id, 'Price modification response missing');
  });

  // TC-010: Post-invoice item removal ────────────────────────────────────────
  await runTest('TC-010', 'Post-invoice item removal (SW-76 §4.6)', async () => {
    const saleRes = await api.post('/transactions', {
      deviceId,
      items: [
        { description: 'Item A', quantity: 1, unitPrice: 20.00, taxCode: 'FP' },
        { description: 'Item B', quantity: 1, unitPrice: 10.00, taxCode: 'FP' },
      ],
      paymentMode: 'CASH',
    });
    const tx = saleRes.data;
    const itemId = tx.items[0]?.id;
    assert(itemId, 'Item ID missing');

    const removeRes = await api.post(`/transactions/${tx.id}/items/${itemId}/remove`, {
      reason: 'Article non disponible',
    });
    assert(removeRes.data.id, 'Item removal response missing');
  });

  // TC-011: Duplicate receipt ────────────────────────────────────────────────
  await runTest('TC-011', 'Duplicate receipt (DUP)', async () => {
    const saleRes = await api.post('/transactions', {
      deviceId,
      items: [{ description: 'Item reçu', quantity: 1, unitPrice: 15.00, taxCode: 'FP' }],
      paymentMode: 'CASH',
    });
    const receipt = await api.get(`/transactions/${saleRes.data.id}/receipt`);
    assert(receipt.data.transaction, 'Receipt transaction data missing');
    assert(receipt.data.mevMention, 'MEV mention missing from receipt');
  });

  // TC-012: Annual report ────────────────────────────────────────────────────
  await runTest('TC-012', 'Annual user report (DOC — RUT)', async () => {
    const currentYear = new Date().getFullYear();
    const reportYear  = currentYear - 1;
    const res = await api.post('/reports/annual', { year: reportYear });
    assert(res.data.id, 'Report ID missing');
    assert(res.data.reportType, 'Report type missing');
  });

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n───────────────────────────────────────────────────────');
  console.log(`\n📊  Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests\n`);

  if (failed > 0) {
    console.log('❌  Failed tests:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => {
      console.log(`   ${r.id}  ${r.name}`);
      console.log(`        → ${r.error}`);
    });
    console.log('');
    process.exit(1);
  } else {
    console.log('✅  All SW-77 test cases passed! Integration is ready for Revenu Québec review.\n');
  }
}

main().catch((err) => {
  console.error('\n💥 Unexpected error:', err.message ?? err);
  process.exit(2);
});
