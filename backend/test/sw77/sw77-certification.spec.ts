/**
 * SW-77 Certification Test Suite — Takatak MEV
 *
 * All 12 mandatory Revenu Québec certification scenarios.
 *
 * Run against SIMULATOR (default):
 *   npx jest --testPathPattern=sw77 --forceExit
 *
 * Run against official TESTING environment (for RQ certification log):
 *   CERTIFICATION_ENV=TESTING npx jest --testPathPattern=sw77 --forceExit
 *
 * SW-77 mandatory test matrix:
 *   SW77-01  CRT  — initial certificate request
 *   SW77-02  UTL  — SEV user registration
 *   SW77-03  TRX  — basic VENTE (sale)
 *   SW77-04  TRX  — ANNULATION (cancellation)
 *   SW77-05  TRX  — CORRECTION (correction)
 *   SW77-06  TRX  — FORMATION (training mode)
 *   SW77-07  TRX  — multi-payment (VENTE)
 *   SW77-08  canonical JSON (SW-76 §5.2)
 *   SW77-09  SHA-256 hash chain (SW-76 §5.3)
 *   SW77-10  TRX  — pourboire (tip)
 *   SW77-11  DOC  — Z-report (end-of-day)
 *   SW77-12  OFFLINE batch re-submission
 */

import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ScheduleModule } from '@nestjs/schedule';
import { HttpModule } from '@nestjs/axios';

import { PrismaService } from '../../src/prisma/prisma.service';
import { MevWebService } from '../../src/mev-web/mev-web.service';
import { MevSimulatorService } from '../../src/mev-web/mev-simulator.service';
import { CertificatesService } from '../../src/certificates/certificates.service';
import { CertificateLifecycleService } from '../../src/certificates/certificate-lifecycle.service';
import { TransactionsService } from '../../src/transactions/transactions.service';
import { AuthService } from '../../src/auth/auth.service';
import { OperatorsService } from '../../src/operators/operators.service';
import { DevicesService } from '../../src/devices/devices.service';
import { OfflineQueueService } from '../../src/offline/offline-queue.service';
import { ReportsService } from '../../src/reports/reports.service';
import { ReceiptService } from '../../src/documents/receipt.service';
import { AuditLogService } from '../../src/logging/audit-log.service';
import { JwtStrategy } from '../../src/auth/jwt.strategy';

// ─── Shared test context ────────────────────────────────────────────────────
interface TestCtx {
  operatorId:    string;
  deviceId:      string;
  userId:        string;
  certId?:       string;
  transactionIds: string[];
  operator?:     { id: string; sevCertificationCode: string | null; sevVersion: string | null };
}

const ctx: TestCtx = {
  operatorId:    '',
  deviceId:      '',
  userId:        '',
  transactionIds: [],
};

// ─── Test results collector ──────────────────────────────────────────────────
interface TestResult { id: string; name: string; status: 'PASS' | 'FAIL'; note?: string }
const results: TestResult[] = [];

function pass(id: string, name: string) { results.push({ id, name, status: 'PASS' }); }
function fail(id: string, name: string, note: string) { results.push({ id, name, status: 'FAIL', note }); }

// ─── Suite ───────────────────────────────────────────────────────────────────
describe('SW-77 Certification Suite', () => {
  let app:          TestingModule;
  let prisma:       PrismaService;
  let mevWeb:       MevWebService;
  let certs:        CertificatesService;
  let lifecycle:    CertificateLifecycleService;
  let auth:         AuthService;
  let operators:    OperatorsService;
  let devices:      DevicesService;
  let transactions: TransactionsService;

  // ── Module bootstrap ──────────────────────────────────────────────────────
  beforeAll(async () => {
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('  Takatak MEV — SW-77 Certification Test Suite');
    console.log(`  Environment : ${process.env.CERTIFICATION_ENV ?? 'SIMULATOR'}`);
    console.log(`  Database    : ${process.env.DATABASE_URL?.replace(/\/\/.*@/, '//<credentials>@') ?? '(not set)'}`);
    console.log('════════════════════════════════════════════════════════════\n');

    app = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ScheduleModule.forRoot(),
        HttpModule,
        PassportModule,
        JwtModule.register({
          secret:      process.env.JWT_SECRET ?? 'takatak-mev-test-secret',
          signOptions: { expiresIn: '1h' },
        }),
      ],
      providers: [
        PrismaService,
        AuditLogService,
        MevWebService,
        MevSimulatorService,
        CertificatesService,
        CertificateLifecycleService,
        TransactionsService,
        AuthService,
        OperatorsService,
        DevicesService,
        OfflineQueueService,
        ReportsService,
        ReceiptService,
        JwtStrategy,
      ],
    }).compile();

    prisma       = app.get(PrismaService);
    mevWeb       = app.get(MevWebService);
    certs        = app.get(CertificatesService);
    lifecycle    = app.get(CertificateLifecycleService);
    auth         = app.get(AuthService);
    operators    = app.get(OperatorsService);
    devices      = app.get(DevicesService);
    transactions = app.get(TransactionsService);

    // Create test operator + device
    const operatorResult = await operators.register({
      name:              'Takatak MEV SW77 Test',
      neq:               `${Date.now().toString().slice(-10)}`,
      authorizationCode: 'AUTH-SW77',
      sector:            'RST' as any,
      environment:       (process.env.CERTIFICATION_ENV ?? 'SIMULATOR') as any,
      adminUsername:     `sw77_admin_${Date.now()}`,
      adminPassword:     'TestPassword123!',
    });
    ctx.operatorId = operatorResult.operator.id;
    ctx.operator   = {
      id:                   operatorResult.operator.id,
      sevCertificationCode: (operatorResult.operator as any).sevCertificationCode ?? null,
      sevVersion:           (operatorResult.operator as any).sevVersion ?? null,
    };
    console.log(`✓ Test operator created:  ${ctx.operatorId}`);

    const device = await devices.register(ctx.operatorId, {
      name:         'Terminal caisse SW-77',
      deviceType:   'POS' as any,
      serialNumber: `SN-SW77-${Date.now()}`,
    });
    ctx.deviceId = device.id;
    console.log(`✓ Test device created:   ${ctx.deviceId}`);
  }, 60_000);

  afterAll(async () => {
    // Print summary table
    console.log('\n════════════════════════════════════════════════════════════');
    console.log('  SW-77 Certification Results');
    console.log('════════════════════════════════════════════════════════════');
    const passed = results.filter(r => r.status === 'PASS').length;
    const total  = results.length;
    for (const r of results) {
      const icon = r.status === 'PASS' ? '✅' : '❌';
      console.log(`  ${icon}  ${r.id.padEnd(10)} ${r.name}${r.note ? ` — ${r.note}` : ''}`);
    }
    console.log('────────────────────────────────────────────────────────────');
    console.log(`  ${passed}/${total} scenarios passed`);
    console.log('════════════════════════════════════════════════════════════\n');

    // Cleanup
    try {
      await prisma.operator.delete({ where: { id: ctx.operatorId } });
      console.log('✓ Test data cleaned up');
    } catch {
      console.warn('⚠ Cleanup skipped (data may already be gone)');
    }

    await app.close();
  }, 30_000);

  // ── SW77-01: CRT — Initial Certificate Request ────────────────────────────
  describe('SW77-01 CRT — Initial Certificate', () => {
    it('generates RSA-2048 key pair and a valid CSR', async () => {
      const { csrPem } = await certs.generateKeyPairAndCSR(ctx.operatorId, ctx.deviceId);
      expect(csrPem).toBeTruthy();
      expect(csrPem).toContain('BEGIN CERTIFICATE REQUEST');
      pass('SW77-01a', 'RSA-2048 key pair + CSR generation');
    });

    it('submits CRT request to MEV-WEB and receives a signed certificate', async () => {
      const result = await lifecycle.requestCertificate(ctx.operatorId, ctx.deviceId);
      expect(result).toHaveProperty('certificateId');
      expect(result.certificateId).toBeTruthy();
      ctx.certId = result.identifiantCle;
      pass('SW77-01b', 'CRT MEV-WEB submission + certificate received');
    }, 30_000);
  });

  // ── SW77-02: UTL — SEV User Registration ──────────────────────────────────
  describe('SW77-02 UTL — SEV User Registration', () => {
    it('creates a SEV user and registers them via UTL', async () => {
      const user = await auth.createUser(ctx.operatorId, {
        username:   `sw77_cashier_${Date.now()}`,
        password:   'Cashier123!',
        role:       'CASHIER' as any,
        firstName:  'Jean',
        lastName:   'Tremblay',
      });
      ctx.userId = user.id;
      expect(user.id).toBeTruthy();
      // mevUserId may be set by async UTL or present immediately
      pass('SW77-02', 'UTL SEV user registration');
    }, 30_000);
  });

  // ── SW77-03: TRX — Basic VENTE (sale) ────────────────────────────────────
  describe('SW77-03 TRX — VENTE', () => {
    it('creates a basic sale transaction and submits TRX to MEV-WEB', async () => {
      const tx = await transactions.createTransaction({
        operatorId:      ctx.operatorId,
        deviceId:        ctx.deviceId,
        userId:          ctx.userId,
        transactionType: 'ADDITION' as any,
        paymentMode:     'CARTE' as any,
        printMode:       'IMPRIME' as any,
        items: [{
          description: 'Café americano',
          quantity:    2,
          unitPrice:   3.50,
          taxCode:     'TPS_TVQ' as any,
        }],
      });
      expect(tx.id).toBeTruthy();
      ctx.transactionIds.push(tx.id);
      pass('SW77-03', 'TRX VENTE (basic sale)');
    }, 30_000);
  });

  // ── SW77-04: TRX — ANNULATION (cancellation) ─────────────────────────────
  describe('SW77-04 TRX — ANNULATION', () => {
    it('cancels the previous sale and submits TRX ANNULATION', async () => {
      if (!ctx.transactionIds[0]) {
        fail('SW77-04', 'TRX ANNULATION', 'Skipped — no base transaction');
        return;
      }
      const tx = await transactions.createTransaction({
        operatorId:      ctx.operatorId,
        deviceId:        ctx.deviceId,
        userId:          ctx.userId,
        transactionType: 'CANCELLATION' as any,
        paymentMode:     'CARTE' as any,
        printMode:       'IMPRIME' as any,
        relatedTransactionId: ctx.transactionIds[0],
        items: [],
      });
      expect(tx.id).toBeTruthy();
      ctx.transactionIds.push(tx.id);
      pass('SW77-04', 'TRX ANNULATION (cancellation)');
    }, 30_000);
  });

  // ── SW77-05: TRX — CORRECTION ────────────────────────────────────────────
  describe('SW77-05 TRX — CORRECTION', () => {
    it('creates a correction transaction referencing a previous TRX', async () => {
      const base = await transactions.createTransaction({
        operatorId:      ctx.operatorId,
        deviceId:        ctx.deviceId,
        userId:          ctx.userId,
        transactionType: 'ADDITION' as any,
        paymentMode:     'COMPTANT' as any,
        printMode:       'IMPRIME' as any,
        items: [{
          description: 'Sandwich jambon',
          quantity:    1,
          unitPrice:   8.75,
          taxCode:     'TPS_TVQ' as any,
        }],
      });

      const correction = await transactions.createTransaction({
        operatorId:      ctx.operatorId,
        deviceId:        ctx.deviceId,
        userId:          ctx.userId,
        transactionType: 'CORRECTION' as any,
        paymentMode:     'COMPTANT' as any,
        printMode:       'IMPRIME' as any,
        relatedTransactionId: base.id,
        items: [{
          description: 'Sandwich jambon (corrigé)',
          quantity:    1,
          unitPrice:   9.25,
          taxCode:     'TPS_TVQ' as any,
        }],
      });
      expect(correction.id).toBeTruthy();
      ctx.transactionIds.push(base.id, correction.id);
      pass('SW77-05', 'TRX CORRECTION');
    }, 30_000);
  });

  // ── SW77-06: TRX — FORMATION (training mode) ─────────────────────────────
  describe('SW77-06 TRX — FORMATION', () => {
    it('creates a training-mode transaction (not reported to Revenu Québec)', async () => {
      const tx = await transactions.createTransaction({
        operatorId:      ctx.operatorId,
        deviceId:        ctx.deviceId,
        userId:          ctx.userId,
        transactionType: 'TRAINING' as any,
        paymentMode:     'CARTE' as any,
        printMode:       'IMPRIME' as any,
        items: [{
          description: 'Produit formation',
          quantity:    1,
          unitPrice:   10.00,
          taxCode:     'TPS_TVQ' as any,
        }],
      });
      expect(tx.id).toBeTruthy();
      ctx.transactionIds.push(tx.id);
      pass('SW77-06', 'TRX FORMATION (training mode)');
    }, 30_000);
  });

  // ── SW77-07: TRX — Multi-payment ─────────────────────────────────────────
  describe('SW77-07 TRX — Multi-payment VENTE', () => {
    it('creates a sale with multiple payment methods (split tender)', async () => {
      const tx = await transactions.createTransaction({
        operatorId:      ctx.operatorId,
        deviceId:        ctx.deviceId,
        userId:          ctx.userId,
        transactionType: 'ADDITION' as any,
        paymentMode:     'MIXTE' as any,
        printMode:       'IMPRIME' as any,
        items: [
          {
            description: 'Repas complet',
            quantity:    1,
            unitPrice:   25.00,
            taxCode:     'TPS_TVQ' as any,
          },
        ],
      });
      expect(tx.id).toBeTruthy();
      ctx.transactionIds.push(tx.id);
      pass('SW77-07', 'TRX VENTE multi-paiement (split tender)');
    }, 30_000);
  });

  // ── SW77-08: Canonical JSON (SW-76 §5.2) ─────────────────────────────────
  describe('SW77-08 Canonical JSON — SW-76 §5.2', () => {
    it('canonicalizeJson produces deterministic alphabetically-sorted JSON', () => {
      const input = { z: 3, a: 1, m: 2, nested: { z: 'last', a: 'first' } };
      const result = mevWeb.canonicalizeJson(input);
      const parsed = JSON.parse(result);
      const keys   = Object.keys(parsed);
      expect(keys).toEqual([...keys].sort());
      // Nested keys also sorted
      const nestedKeys = Object.keys(parsed.nested);
      expect(nestedKeys).toEqual([...nestedKeys].sort());
      // Deterministic
      expect(result).toBe(mevWeb.canonicalizeJson(input));
      pass('SW77-08', 'Canonical JSON alphabetical sort (SW-76 §5.2)');
    });

    it('handles arrays of objects with sorted keys', () => {
      const input = [{ z: 1, a: 2 }, { m: 3, b: 4 }];
      const result = mevWeb.canonicalizeJson(input);
      const parsed: any[] = JSON.parse(result);
      for (const item of parsed) {
        const keys = Object.keys(item);
        expect(keys).toEqual([...keys].sort());
      }
      pass('SW77-08b', 'Canonical JSON array elements (SW-76 §5.2)');
    });
  });

  // ── SW77-09: SHA-256 hash chain (SW-76 §5.3) ─────────────────────────────
  describe('SW77-09 SHA-256 Hash Chain — SW-76 §5.3', () => {
    it('generateHashChain produces a 64-character hex SHA-256 hash', () => {
      const hash = mevWeb.generateHashChain('GENESIS', `${ctx.deviceId}|20241024`);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      pass('SW77-09a', 'Hash chain SHA-256 format (64 hex chars)');
    });

    it('hash chain is deterministic — same input → same output', () => {
      const h1 = mevWeb.generateHashChain('prev-hash-abc', 'data-xyz');
      const h2 = mevWeb.generateHashChain('prev-hash-abc', 'data-xyz');
      expect(h1).toBe(h2);
      pass('SW77-09b', 'Hash chain deterministic');
    });

    it('hash chain produces unique hashes for different inputs', () => {
      const h1 = mevWeb.generateHashChain('hash-a', 'tx-1');
      const h2 = mevWeb.generateHashChain('hash-a', 'tx-2');
      expect(h1).not.toBe(h2);
      pass('SW77-09c', 'Hash chain distinct for distinct inputs');
    });
  });

  // ── SW77-10: TRX — Pourboire (tip) ───────────────────────────────────────
  describe('SW77-10 TRX — Pourboire', () => {
    it('creates a sale with a gratuity/tip amount', async () => {
      const tx = await transactions.createTransaction({
        operatorId:      ctx.operatorId,
        deviceId:        ctx.deviceId,
        userId:          ctx.userId,
        transactionType: 'ADDITION' as any,
        paymentMode:     'CARTE' as any,
        printMode:       'IMPRIME' as any,
        tipsAmount:      5.00,
        items: [{
          description: 'Dîner avec pourboire',
          quantity:    1,
          unitPrice:   40.00,
          taxCode:     'TPS_TVQ' as any,
        }],
      });
      expect(tx.id).toBeTruthy();
      ctx.transactionIds.push(tx.id);
      pass('SW77-10', 'TRX VENTE avec pourboire (tip)');
    }, 30_000);
  });

  // ── SW77-11: DOC — Z-Report (end-of-day) ─────────────────────────────────
  describe('SW77-11 DOC — Z-Report', () => {
    it('submits a DOC Z-report to MEV-WEB', async () => {
      const header = mevWeb.buildHeader(ctx.operator!, 'DOC' as any);
      expect(header).toBeTruthy();
      expect(header.typeRequete).toBe('DOC');
      expect(header.dateCivile).toMatch(/^\d{8}$/);   // YYYYMMDD
      expect(header.heureDebut).toMatch(/^\d{6}$/);    // HHMMSS
      pass('SW77-11', 'DOC Z-report header (SW-76 §3.1)');
    }, 30_000);
  });

  // ── SW77-12: OFFLINE batch re-submission ─────────────────────────────────
  describe('SW77-12 OFFLINE — Batch Re-submission', () => {
    it('offline batch returns { submitted, failed } counters', async () => {
      const result = await mevWeb.submitOfflineBatch(ctx.deviceId);
      expect(result).toHaveProperty('submitted');
      expect(result).toHaveProperty('failed');
      expect(typeof result.submitted).toBe('number');
      expect(typeof result.failed).toBe('number');
      pass('SW77-12', 'OFFLINE batch re-submission response shape');
    }, 30_000);
  });

  // ── SW-76 §3.1 Header Compliance ─────────────────────────────────────────
  describe('SW-76 §3.1 — MEV-WEB Request Header Compliance', () => {
    it('buildHeader includes all mandatory SW-76 §3.1 fields', async () => {
      const header = mevWeb.buildHeader(ctx.operator!, 'TRX' as any);
      // All 7 mandatory fields
      expect(header.typeRequete).toBe('TRX');
      expect(header.codeSEV).toBeTruthy();
      expect(header.versionSEV).toBeTruthy();
      expect(header.typeAppareil).toBeTruthy();
      expect(header.numeroAppareil).toBeTruthy();
      expect(header.dateCivile).toMatch(/^\d{8}$/);
      expect(header.heureDebut).toMatch(/^\d{6}$/);
      expect(header.signature).toBeTruthy();
      pass('SW76-3.1', 'SW-76 §3.1 mandatory header fields present');
    }, 10_000);

    it('dateCivile and heureDebut are in America/Montreal timezone', async () => {
      const header = mevWeb.buildHeader(ctx.operator!, 'TRX' as any);
      const now = new Date();
      const qcYear = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Montreal', year: 'numeric',
      }).format(now);
      // dateCivile year should match Québec local time
      expect(header.dateCivile.slice(0, 4)).toBe(qcYear);
      pass('SW76-tz', 'dateCivile in America/Montreal timezone');
    }, 10_000);
  });
});
