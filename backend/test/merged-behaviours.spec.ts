/**
 * Behaviours brought from the core line (origin/main) onto the official layer, checked without a database:
 * runtime check of stored transactions, request DTOs, renewal / registration / rate-limit settings.
 * The database flows (registration, UTL sync, renewal, offline write-back, tenant isolation) are in test/sw77.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import * as crypto from 'crypto';
import { RegisterDeviceDto, UpdateDeviceDto } from '../src/devices/dto/device.dto';
import { CreateUserDto } from '../src/auth/dto/create-user.dto';
import { ConfigError, loadConfig } from '../src/config/app-config';
import { FIRST_PRECED, generateP256, signP256 } from '../src/crypto/ecdsa';
import { assertTransActu, assertTransCore, InvalidMevPayloadError } from '../src/mev-web/payload-validator';
import type { TransActu, TransCore } from '../src/mev-web/mev-web.types';
import { RegisterOperatorDto, UpdateOperatorDto } from '../src/operators/dto/register-operator.dto';
import { CreateTransactionDto, ModifyPriceDto } from '../src/transactions/dto/transaction.dto';
import { buildTransCore, SaleDraft } from '../src/transactions/trans-builder';

const identity = { noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001' };
const draft: SaleDraft = {
  documentKind: 'RECEIPT', typTrans: 'RFER', modImpr: 'FAC', formImpr: 'PAP', modTrans: 'OPE', typServ: 'CMP', ecommerce: false, modPai: 'ARG',
  lines: [{ description: 'Poutine', quantity: '1', unitPriceCents: 1299, totalCents: 1299, tax: 'FP', activity: 'RES' }],
  tipCents: 200,
};

function signed(): TransCore {
  const keys = generateP256();
  const { core, signedString } = buildTransCore(
    draft,
    { noTrans: '7', datTrans: '20261024120000', utc: '-04:00', datActu: '20261024120000', nomUtil: 'staff-e2e', preced: FIRST_PRECED, ref: { noTrans: '6', datTrans: '20261024115900', subtotalCents: 1299 } },
    identity,
  );
  return { ...core, signa: { actu: signP256(keys.privateKeyPem, signedString), preced: FIRST_PRECED, datActu: core.datTrans } };
}

const problems = (fn: () => void): string[] => {
  try {
    fn();
    return [];
  } catch (e) {
    if (e instanceof InvalidMevPayloadError) return e.problems;
    throw e;
  }
};

describe('runtime check of a stored transaction (official names)', () => {
  it('accepts what the builder signs, with and without the identity values', () => {
    const core = signed();
    expect(() => assertTransCore(core)).not.toThrow();
    const actu: TransActu = { ...core, noDossFO: 'ER0000', ...identity };
    expect(() => assertTransActu(actu)).not.toThrow();
    expect(problems(() => assertTransActu(core))).toEqual(['noDossFO missing', 'noTPS missing', 'noTVQ missing']);
  });

  it('lists every problem of a tampered record', () => {
    const t = signed() as unknown as Record<string, unknown>;
    const bad = {
      ...t,
      datTrans: '2026-10-24',
      typTrans: 'VENTE',
      modPai: 'CARTE',
      mont: { ...(t.mont as object), apresTax: '15' },
      items: [{ qte: 'two', descr: '', unitr: '12.99', prix: '12.99', tax: 'TPS_TVQ', acti: 'RES' }],
      signa: { actu: 'short', preced: FIRST_PRECED, datActu: '20261024120000' },
      refs: [{ noTrans: '6' }],
    };
    const p = problems(() => assertTransCore(bad));
    for (const expected of ['datTrans', 'typTrans', 'modPai', 'mont.apresTax', 'items[0].qte', 'items[0].descr', 'items[0].tax', 'signa.actu', 'refs[0]']) {
      expect(p.some((x) => x.startsWith(expected))).toBe(true);
    }
    expect(problems(() => assertTransCore(null))).toEqual(['the transaction is not an object']);
  });

  it('refuses the invented names of the old layer (typeTransaction, montantTotal...)', () => {
    const p = problems(() => assertTransCore({ numeroTransaction: 1, typeTransaction: 'VEN', montantTotal: 12.5, fournitures: [] }));
    expect(p.length).toBeGreaterThan(5);
  });
});

describe('request DTOs (class-validator)', () => {
  const errorsOf = <T extends object>(cls: new () => T, body: unknown) =>
    validateSync(plainToInstance(cls, body) as object, { whitelist: true }).flatMap((e) => [e.property, ...(e.children ?? []).map((c) => `${e.property}.${c.property}`)]);

  it('RegisterOperatorDto: NEQ 10 digits, TPS / TVQ formats, sector RBC, 12-character password', () => {
    const ok = { name: 'Restaurant Démo', neq: '0000000000', noTPS: identity.noTPS, noTVQ: identity.noTVQ, adminUsername: 'admin-demo', adminPassword: 'x'.repeat(12) };
    expect(errorsOf(RegisterOperatorDto, ok)).toEqual([]);
    expect(errorsOf(RegisterOperatorDto, { ...ok, neq: '123', noTPS: '123', noTVQ: 'TQ', sector: 'RST', adminPassword: 'short' })).toEqual(
      expect.arrayContaining(['neq', 'noTPS', 'noTVQ', 'sector', 'adminPassword']),
    );
    expect(errorsOf(UpdateOperatorDto, { postalCode: 'H0H 0H0', email: 'not-an-email' })).toEqual(['email']);
  });

  it('CreateUserDto and device DTOs', () => {
    expect(errorsOf(CreateUserDto, { username: 'caissier1', password: 'x'.repeat(12), firstName: 'Jean', role: 'CASHIER' })).toEqual([]);
    expect(errorsOf(CreateUserDto, { username: 'a', password: 'short', firstName: '', role: 'SYSTEM' })).toEqual(expect.arrayContaining(['username', 'password', 'firstName', 'role']));
    expect(errorsOf(RegisterDeviceDto, { serialNumber: 'CAISSE-1', name: 'Caisse 1', model: 'X', firmwareVersion: '1.0', fileNumber: 'ER0000', authorizationCode: 'XXXX-XXXX' })).toEqual([]);
    expect(errorsOf(RegisterDeviceDto, { serialNumber: '', deviceType: 'POS', authorizationCode: 'abc' })).toEqual(expect.arrayContaining(['serialNumber', 'deviceType', 'authorizationCode']));
    expect(errorsOf(UpdateDeviceDto, { isActive: 'yes' })).toEqual(['isActive']);
  });

  it('CreateTransactionDto: official codes, integer cents, decimal quantities (a number is converted)', () => {
    const ok = { deviceId: crypto.randomUUID(), paymentMode: 'ARG', items: [{ description: 'Poutine', quantity: 2, unitPriceCents: 1299, tax: 'FP' }] };
    expect(errorsOf(CreateTransactionDto, ok)).toEqual([]);
    expect((plainToInstance(CreateTransactionDto, ok).items[0].quantity)).toBe('2');
    expect(errorsOf(CreateTransactionDto, { deviceId: 'x', paymentMode: 'CASH', items: [{ description: 'P', quantity: '1.2345', unitPriceCents: 12.5, tax: 'TPS_TVQ' }] })).toEqual(
      expect.arrayContaining(['deviceId', 'paymentMode', 'items', 'items.0']),
    );
    expect(errorsOf(CreateTransactionDto, { deviceId: crypto.randomUUID(), paymentMode: 'ARG', items: [] })).toContain('items');
    expect(errorsOf(ModifyPriceDto, { newUnitPriceCents: -1 })).toEqual(['newUnitPriceCents']);
  });
});

describe('settings brought from the core line', () => {
  const good = { JWT_SECRET: crypto.randomBytes(32).toString('hex'), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') };

  it('defaults: renewal window 30 days, public registration on, rate limit 10/s and 100/min', () => {
    const c = loadConfig(good);
    expect(c.certRenewalDays).toBe(30);
    expect(c.simulatorCertValidityDays).toBe(730);
    expect(c.publicRegistration).toBe(true);
    expect(c.rateLimit).toEqual({ perSecond: 10, perMinute: 100 });
  });

  it('reads and validates the overrides', () => {
    const c = loadConfig({ ...good, CERT_RENEWAL_DAYS: '10', SIMULATOR_CERT_VALIDITY_DAYS: '5', QCMEV_PUBLIC_REGISTRATION: 'false', QCMEV_RATE_LIMIT_PER_SECOND: '50', QCMEV_RATE_LIMIT_PER_MINUTE: '1000' });
    expect([c.certRenewalDays, c.simulatorCertValidityDays, c.publicRegistration, c.rateLimit.perSecond, c.rateLimit.perMinute]).toEqual([10, 5, false, 50, 1000]);
    expect(() => loadConfig({ ...good, CERT_RENEWAL_DAYS: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...good, QCMEV_RATE_LIMIT_PER_MINUTE: 'lots' })).toThrow(ConfigError);
  });
});
