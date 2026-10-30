/**
 * PR #3 review minors, checked without a database (the database flows are in test/sw77 and scripts/verify-foodhub-e2e):
 *  - UTL is never sent with an expired SEV certificate (PROVEN: an expired certificate transmits nothing);
 *  - a Food Hub location is linked to a device through the API (no seed CLI needed), which also creates and registers
 *    the operator's FOODHUB-AUTO user.
 */
import 'reflect-metadata';
import * as crypto from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { loadConfig } from '../src/config/app-config';
import { FoodHubLocationsService, LinkFoodHubLocationDto } from '../src/integrations/foodhub/foodhub-locations';
import { FOODHUB_AUTO, FOODHUB_AUTO_EXTERNAL_ID } from '../src/integrations/foodhub/foodhub.service';
import { OperatorsService } from '../src/operators/operators';
import { LocationNotReadyError } from '../src/transactions/transactions.service';

/* eslint-disable @typescript-eslint/no-explicit-any */
const cfg = loadConfig({ JWT_SECRET: crypto.randomBytes(32).toString('hex'), PRIVATE_KEY_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'), QCMEV_FOODHUB_ENABLED: 'false' });
const identity = { id: 'op', noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001' };

describe('UTL with an expired SEV certificate', () => {
  function harness(expiredDevices: string[]) {
    const devices = [{ id: 'dev-a', serialNumber: 'SN-A' }, { id: 'dev-b', serialNumber: 'SN-B' }];
    const updates: any[] = [];
    const audits: any[] = [];
    const prisma: any = {
      sEVUser: { findFirst: async () => ({ id: 'u1', operatorId: 'op', mevUserName: 'staff' }), update: async (a: any) => (updates.push(a), {}) },
      operator: { findUniqueOrThrow: async () => identity },
      device: { findMany: async (a: any) => devices.filter((d) => !a.where.id || d.id === a.where.id) },
    };
    const certificates: any = { signingMaterial: async (id: string) => ({ deviceId: id, expired: expiredDevices.includes(id), validUntil: new Date() }) };
    const sentWith: string[] = [];
    const mevWeb: any = { userRequest: jest.fn(async (_op: unknown, m: any) => (sentWith.push(m.deviceId), { retourUtil: { listErr: [] } })) };
    const ops = new OperatorsService(cfg, prisma, certificates, mevWeb, { log: async (a: any) => void audits.push(a) } as any);
    return { ops, updates, audits, sentWith, mevWeb };
  }

  it('every certified device expired: nothing is sent, the user is not marked registered, 423 certReady, CRITICAL audit', async () => {
    const h = harness(['dev-a', 'dev-b']);
    const p = h.ops.registerSevUser('op', 'u1', 'AJO');
    await expect(p).rejects.toBeInstanceOf(LocationNotReadyError);
    await expect(p).rejects.toMatchObject({ field: 'certReady' });
    expect(h.mevWeb.userRequest).not.toHaveBeenCalled();
    expect(h.updates).toEqual([]);
    expect(h.audits).toEqual([expect.objectContaining({ eventType: 'MEV_ERROR', severity: 'CRITICAL', metadata: { devices: ['SN-A', 'SN-B'] } })]);
  });

  it('one device expired: UTL goes only through the device whose certificate is valid; the expired one is skipped and audited', async () => {
    const h = harness(['dev-b']);
    const r = await h.ops.registerSevUser('op', 'u1', 'AJO');
    expect(h.sentWith).toEqual(['dev-a']);
    expect(r).toMatchObject({ status: 'registered', devices: 1, skippedExpiredDevices: 1 });
    expect(h.updates).toHaveLength(1);
    expect(h.audits.map((a) => `${a.eventType}/${a.severity ?? 'INFO'}`)).toEqual(['MEV_ERROR/CRITICAL', 'USER_REGISTERED/INFO']);
  });

  it('createUser and syncMevUsers keep working: the user is created, its UTL waits for the renewal', async () => {
    const h = harness(['dev-a', 'dev-b']);
    const prisma: any = (h.ops as any).prisma;
    prisma.sEVUser.findUnique = async () => null;
    prisma.sEVUser.create = async (a: any) => ({ id: 'u1', username: a.data.username, role: a.data.role, mevUserName: a.data.mevUserName });
    const created = await h.ops.createUser('op', { username: 'nouveau', password: 'Mot-de-passe-long-1', firstName: 'Nouveau', lastName: 'Employé' } as any);
    expect(created.registration).toMatchObject({ status: 'not_registered', reason: expect.stringContaining('expired') });
    expect(h.mevWeb.userRequest).not.toHaveBeenCalled();
  });

  it('after the renewal (CRT REM), the renewed device registers every active user (syncUsersToDevice)', async () => {
    const h = harness([]);
    const prisma: any = (h.ops as any).prisma;
    prisma.sEVUser.findMany = async () => [{ id: 'u1' }];
    expect(await h.ops.syncUsersToDevice('op', 'dev-b')).toEqual([{ userId: 'u1', ok: true }]);
    expect(h.sentWith).toEqual(['dev-b']);
  });
});

describe('Food Hub location → device, through the API (no seed CLI)', () => {
  function harness(o: { autoRegistered?: boolean; autoExists?: boolean; registerFails?: boolean } = {}) {
    const maps: any[] = [];
    const users: any[] = o.autoExists ? [{ id: 'auto', operatorId: 'op', externalId: FOODHUB_AUTO_EXTERNAL_ID, isActive: true, mevRegisteredAt: o.autoRegistered ? new Date() : null }] : [];
    const devices = [
      { id: 'dev-a', operatorId: 'op', isActive: true, serialNumber: 'SN-A', name: 'Cuisine A', mevDeviceId: 'SIM1' },
      { id: 'dev-x', operatorId: 'other', isActive: true, serialNumber: 'SN-X', name: 'Ailleurs', mevDeviceId: 'SIM9' },
      { id: 'dev-off', operatorId: 'op', isActive: false, serialNumber: 'SN-OFF', name: null, mevDeviceId: null },
    ];
    const pick = (o2: any, sel?: any) => (sel ? Object.fromEntries(Object.keys(sel).map((k) => [k, o2[k]])) : o2);
    const prisma: any = {
      device: {
        findFirst: async (a: any) => devices.find((d) => d.id === a.where.id && d.operatorId === a.where.operatorId) ?? null,
        findUniqueOrThrow: async (a: any) => pick(devices.find((d) => d.id === a.where.id), a.select),
      },
      locationMapping: {
        findUnique: async (a: any) => maps.find((m) => m.tenantId === a.where.tenantId_locationId.tenantId && m.locationId === a.where.tenantId_locationId.locationId) ?? null,
        findFirst: async (a: any) => maps.find((m) => m.id === a.where.id && m.operatorId === a.where.operatorId) ?? null,
        findMany: async (a: any) => maps.filter((m) => m.operatorId === a.where.operatorId),
        create: async (a: any) => {
          const m = { id: `map-${maps.length + 1}`, isActive: true, createdAt: new Date(), ...a.data };
          maps.push(m);
          return m;
        },
        update: async (a: any) => Object.assign(maps.find((m) => m.id === a.where.id), a.data),
      },
      sEVUser: {
        findUnique: async (a: any) => users.find((u) => u.operatorId === a.where.operatorId_externalId.operatorId && u.externalId === a.where.operatorId_externalId.externalId) ?? null,
        create: async (a: any) => {
          const u = { id: 'auto', mevRegisteredAt: null, ...a.data };
          users.push(u);
          return u;
        },
      },
    };
    const certificates: any = { readiness: async (id: string) => ({ deviceReady: id === 'dev-a', certReady: id === 'dev-a', certificateValidUntil: null }) };
    const operators: any = {
      registerSevUser: jest.fn(async (_op: string, userId: string) => {
        if (o.registerFails) throw new Error('No certified device yet: run the certificate request (CRT) first');
        users.find((u) => u.id === userId).mevRegisteredAt = new Date();
        return { status: 'registered' };
      }),
    };
    const audits: any[] = [];
    const svc = new FoodHubLocationsService(cfg, prisma, certificates, operators, { log: async (a: any) => void audits.push(a) } as any);
    return { svc, maps, users, operators, audits };
  }
  const admin = { sub: 'admin', operatorId: 'op', role: 'ADMIN' } as any;
  const dto = (o: Partial<LinkFoodHubLocationDto> = {}): LinkFoodHubLocationDto => ({ tenantId: 'takatak', locationId: 'KITCHEN_A', deviceId: 'dev-a', ...o });

  it('link: the mapping, then FOODHUB-AUTO created (system user, no password) and registered with UTL → the location is ready', async () => {
    const h = harness();
    const r = await h.svc.link(admin, dto());
    expect(h.maps).toEqual([expect.objectContaining({ tenantId: 'takatak', locationId: 'KITCHEN_A', operatorId: 'op', deviceId: 'dev-a', isActive: true })]);
    expect(h.users).toEqual([expect.objectContaining({ role: 'SYSTEM', passwordHash: null, mevUserName: FOODHUB_AUTO, externalId: FOODHUB_AUTO_EXTERNAL_ID })]);
    expect(h.operators.registerSevUser).toHaveBeenCalledWith('op', 'auto', 'AJO');
    expect(r).toMatchObject({ locationId: 'KITCHEN_A', deviceReady: true, certReady: true, usersReady: true, foodhubAuto: { created: true, registration: 'registered' }, device: { serialNumber: 'SN-A' } });
    expect(JSON.stringify(r)).not.toMatch(/fileNumber|authorizationCode/);
    expect(h.audits.map((a) => a.eventType)).toEqual(['SETTINGS_CHANGED', 'USER_REGISTERED']);
  });

  it('link before any certificate: linked, FOODHUB-AUTO created but not registered yet (the CRT registers it), usersReady false', async () => {
    const h = harness({ registerFails: true });
    const r = await h.svc.link(admin, dto());
    expect(r).toMatchObject({ usersReady: false, foodhubAuto: { created: true, registration: expect.stringMatching(/^not_registered: No certified device/) } });
  });

  it('an operator that already has a registered FOODHUB-AUTO: no new user, no new UTL', async () => {
    const h = harness({ autoExists: true, autoRegistered: true });
    const r = await h.svc.link(admin, dto());
    expect(h.users).toHaveLength(1);
    expect(h.operators.registerSevUser).not.toHaveBeenCalled();
    expect(r).toMatchObject({ usersReady: true, foodhubAuto: { created: false, registration: 'registered' } });
  });

  it('refusals: another operator’s device (404), an inactive device (409), another operator’s location (409)', async () => {
    const h = harness();
    await expect(h.svc.link(admin, dto({ deviceId: 'dev-x' }))).rejects.toMatchObject({ status: 404 });
    await expect(h.svc.link(admin, dto({ deviceId: 'dev-off' }))).rejects.toMatchObject({ status: 409 });
    h.maps.push({ id: 'theirs', tenantId: 'takatak', locationId: 'KITCHEN_B', operatorId: 'other', deviceId: 'dev-x', isActive: true });
    await expect(h.svc.link(admin, dto({ locationId: 'KITCHEN_B' }))).rejects.toMatchObject({ status: 409 });
    expect(h.maps.find((m) => m.id === 'theirs')).toMatchObject({ operatorId: 'other', deviceId: 'dev-x' });
  });

  it('unlink keeps the row, inactive; the list shows it and whether the signed Food Hub API is on', async () => {
    const h = harness({ autoExists: true, autoRegistered: true });
    const linked = await h.svc.link(admin, dto());
    const off = await h.svc.unlink(admin, linked.id);
    expect(off).toMatchObject({ id: linked.id, isActive: false });
    await expect(h.svc.unlink({ ...admin, operatorId: 'other' }, linked.id)).rejects.toMatchObject({ status: 404 });
    const list = await h.svc.list('op');
    expect(list).toMatchObject({ foodhubEnabled: false, locations: [{ locationId: 'KITCHEN_A', isActive: false }] });
    // Linking it again re-activates the same row.
    await h.svc.link(admin, dto());
    expect(h.maps).toHaveLength(1);
    expect(h.maps[0].isActive).toBe(true);
  });

  it('the body uses the same rules as the signed calls (tenant slug, locationId, device uuid)', () => {
    const errors = (b: unknown) => validateSync(plainToInstance(LinkFoodHubLocationDto, b)).map((e) => e.property).sort();
    expect(errors({ tenantId: 'takatak', locationId: 'KITCHEN_A', deviceId: crypto.randomUUID() })).toEqual([]);
    expect(errors({ tenantId: 'Takatak!', locationId: 'cuisine a', deviceId: 'x' })).toEqual(['deviceId', 'locationId', 'tenantId']);
  });
});
