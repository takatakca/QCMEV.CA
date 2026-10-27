/**
 * The dashboard reads the API answers the backend really sends. Regression: the home page's « Environnement » tile read
 * mevStatus.operator.mevEnvironment, a field GET /api/operators/mev-status never had, so it always showed « – ».
 * This test calls the real services (stubbed database) and checks every field the pages read exists in the answer.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../src/config/app-config';
import { FoodHubLocationsService } from '../src/integrations/foodhub/foodhub-locations';
import { OperatorsService } from '../src/operators/operators';

/* eslint-disable @typescript-eslint/no-explicit-any */
const cfg = loadConfig({ JWT_SECRET: crypto.randomBytes(32).toString('hex'), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex') });
const page = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'pages', rel), 'utf8');
/** Every `<name>.field` / `<name>?.field` the page reads (first level only). */
const reads = (src: string, name: string) => [...new Set([...src.matchAll(new RegExp(`\\b${name}\\??\\.([A-Za-z_]\\w*)`, 'g'))].map((m) => m[1]))];

function service() {
  const prisma: any = {
    device: { findMany: async () => [{ id: 'd', serialNumber: 'S', name: 'Cuisine', mevDeviceId: 'SIM1', offlineMode: false, offlineSince: null, lastSyncAt: null }] },
    offlineQueue: { count: async () => 0, findFirst: async () => null },
    operator: {
      findUnique: async () => ({ id: 'op', name: 'Restaurant Démo', sector: 'RBC', address: null, city: 'Montréal', province: 'QC', postalCode: null, addressUtc: '-05:00', phone: null, email: null, environment: 'SIMULATOR', createdAt: new Date() }),
    },
  };
  const certificates: any = { expiring: async () => [{ validUntil: new Date(Date.now() + 86400_000) }] };
  const mevWeb: any = { reachability: () => ({ mevReachable: true, lastOkAt: null, lastFailAt: null }) };
  return new OperatorsService(cfg, prisma, certificates, mevWeb, { log: async () => undefined } as any);
}

describe('dashboard home (frontend/src/pages/index.tsx) ↔ the API', () => {
  it('GET /operators/mev-status has the environment at the top level, and every field the page reads', async () => {
    const status = await service().mevStatus('op');
    expect(status.environment).toBe(cfg.mevEnvironment);
    expect(status.certified).toBe(false);
    const src = page('index.tsx');
    expect(src).not.toMatch(/mevStatus\??\.operator/);
    const fields = reads(src, 'mevStatus');
    expect(fields).toEqual(expect.arrayContaining(['environment', 'certified']));
    expect(fields.filter((f) => !(f in status))).toEqual([]);
  });

  it('the operator card reads GET /operators/me, which never carries an identity number or the authorization code', async () => {
    const me = await service().me('op');
    const fields = reads(page('index.tsx'), 'operator');
    expect(fields.length).toBeGreaterThan(0);
    expect(fields.filter((f) => !(f in me))).toEqual([]);
    const identity = ['neq', 'authorizationCode', 'authorizationCodeEnc', 'fileNumber', 'noTPS', 'noTVQ'];
    expect(fields.filter((f) => identity.includes(f))).toEqual([]);
    expect(Object.keys(me).filter((k) => identity.includes(k))).toEqual([]);
  });
});

describe('Food Hub kitchens card (frontend/src/components/FoodHubLocations.tsx) ↔ /operators/foodhub-locations', () => {
  it('every field the card reads exists in the list and link answers', async () => {
    const mapping = { id: 'm1', tenantId: 'takatak', locationId: 'KITCHEN_A', operatorId: 'op', deviceId: 'd', isActive: true };
    const prisma: any = {
      device: { findFirst: async () => ({ id: 'd', isActive: true, serialNumber: 'S' }), findUniqueOrThrow: async () => ({ id: 'd', name: 'Cuisine', serialNumber: 'S', mevDeviceId: 'SIM1' }) },
      locationMapping: { findMany: async () => [mapping], findUnique: async () => mapping, update: async () => mapping },
      sEVUser: { findUnique: async () => ({ id: 'auto', isActive: true, mevRegisteredAt: new Date() }) },
    };
    const certificates: any = { readiness: async () => ({ deviceReady: true, certReady: true, certificateValidUntil: null }) };
    const svc = new FoodHubLocationsService(cfg, prisma, certificates, {} as any, { log: async () => undefined } as any);
    const list = await svc.list('op');
    const linked = await svc.link({ sub: 'u', operatorId: 'op', role: 'ADMIN' } as any, { tenantId: 'takatak', locationId: 'KITCHEN_A', deviceId: 'd' });
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'src', 'components', 'FoodHubLocations.tsx'), 'utf8');
    expect(src).toMatch(/data\?\.locations/);
    expect(src).toMatch(/data\.foodhubEnabled/);
    expect(Object.keys(list)).toEqual(expect.arrayContaining(['locations', 'foodhubEnabled']));
    const row = reads(src, 'l');
    expect(row.length).toBeGreaterThan(5);
    expect(row.filter((f) => !(f in list.locations[0]))).toEqual([]);
    const afterLink = [...src.matchAll(/\br\.data\??\.([A-Za-z_]\w*)/g)].map((m) => m[1]);
    expect(afterLink.filter((f) => !(f in linked))).toEqual([]);
  });
});
