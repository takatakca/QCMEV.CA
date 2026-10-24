/**
 * npm run seed:operator — creates (or updates) the first operator, its devices, the admin, the FOODHUB-AUTO system
 * user and the Food Hub location mappings, from a JSON file kept OUTSIDE the repository.
 *
 *   SEED_FILE=/path/outside/repo/seed.json DATABASE_URL=... PRIVATE_KEY_ENCRYPTION_KEY=... MEV_ENVIRONMENT=SIMULATOR npm run seed:operator
 *
 * seed.json:
 * {
 *   "operator": { "name": "...", "neq": "...", "noTPS": "...", "noTVQ": "...", "address": "...", "city": "..." },
 *   "admin": { "username": "...", "password": "...(12+ chars)", "firstName": "...", "lastName": "..." },
 *   "staff": [{ "username": "...", "password": "...", "mevUserName": "...", "role": "CASHIER", "externalId": "foodhub:<staff id>" }],
 *   "devices": [{ "serialNumber": "...", "fileNumber": "...", "authorizationCode": "XXXX-XXXX", "foodhubLocationId": "..." }],
 *   "foodhubTenantId": "takatak"
 * }
 * Identity values and the authorization code stay in the database (the code AES-256-GCM encrypted). Nothing secret
 * is printed. Real values are typed by the owner; tests use obvious placeholders only.
 */
import { PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import * as fs from 'fs';
import { MEV_ENVS, MevEnv, parseKeyEncryptionKey } from '../config/app-config';
import { KeyVault } from '../crypto/key-vault';

const FOODHUB_AUTO = 'FOODHUB-AUTO';

interface SeedFile {
  operator: { name: string; neq: string; noTPS: string; noTVQ: string; address?: string; city?: string; postalCode?: string };
  admin: { username: string; password: string; firstName?: string; lastName?: string; mevUserName?: string };
  staff?: Array<{ username: string; password: string; mevUserName?: string; role?: string; externalId?: string; firstName?: string; lastName?: string }>;
  devices: Array<{ serialNumber: string; fileNumber: string; authorizationCode: string; foodhubLocationId?: string; description?: string }>;
  foodhubTenantId?: string;
}

function fail(msg: string): never {
  // eslint-disable-next-line no-console
  console.error(`seed:operator: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  try {
    process.loadEnvFile?.('.env');
  } catch {
    /* no .env */
  }
  const file = process.env.SEED_FILE;
  if (!file) fail('SEED_FILE is required (a JSON file outside the repository)');
  const seed = JSON.parse(fs.readFileSync(file, 'utf8')) as SeedFile;
  const env = (process.env.MEV_ENVIRONMENT ?? 'SIMULATOR').toUpperCase() as MevEnv;
  if (!MEV_ENVS.includes(env)) fail('MEV_ENVIRONMENT is invalid');
  const vault = new KeyVault(parseKeyEncryptionKey(process.env.PRIVATE_KEY_ENCRYPTION_KEY ?? ''));
  const o = seed.operator;
  if (!o?.name || !o.neq || !o.noTPS || !o.noTVQ) fail('operator.name, neq, noTPS and noTVQ are required');
  if (!seed.admin?.username || (seed.admin.password ?? '').length < 12) fail('admin.username and a 12+ character admin.password are required');
  if (!seed.devices?.length) fail('at least one device is required');
  for (const d of seed.devices) {
    if (!d.serialNumber || !d.fileNumber || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(d.authorizationCode ?? '')) fail('each device needs serialNumber, fileNumber and an authorizationCode like XXXX-XXXX');
  }

  const prisma = new PrismaClient({ errorFormat: 'minimal' });
  try {
    const operator = await prisma.operator.upsert({
      where: { neq: o.neq },
      update: { name: o.name, noTPS: o.noTPS, noTVQ: o.noTVQ, address: o.address, city: o.city, postalCode: o.postalCode, environment: env },
      create: { name: o.name, neq: o.neq, noTPS: o.noTPS, noTVQ: o.noTVQ, address: o.address, city: o.city, postalCode: o.postalCode, environment: env },
    });

    const devices: Array<{ id: string; serialNumber: string; locationId?: string }> = [];
    for (const d of seed.devices) {
      const existing = await prisma.device.findUnique({ where: { serialNumber: d.serialNumber } });
      if (existing && existing.operatorId !== operator.id) fail(`device ${d.serialNumber} belongs to another operator`);
      const dev = existing
        ? await prisma.device.update({ where: { id: existing.id }, data: { fileNumber: d.fileNumber, description: d.description } })
        : await prisma.device.create({ data: { operatorId: operator.id, serialNumber: d.serialNumber, deviceType: 'SERVER', fileNumber: d.fileNumber, description: d.description } });
      await prisma.device.update({ where: { id: dev.id }, data: { authorizationCodeEnc: vault.encrypt(d.authorizationCode, `auth:${dev.id}`) } });
      devices.push({ id: dev.id, serialNumber: dev.serialNumber, locationId: d.foodhubLocationId });
      if (d.foodhubLocationId) {
        const tenantId = seed.foodhubTenantId ?? 'takatak';
        await prisma.locationMapping.upsert({
          where: { tenantId_locationId: { tenantId, locationId: d.foodhubLocationId } },
          update: { operatorId: operator.id, deviceId: dev.id, isActive: true },
          create: { tenantId, locationId: d.foodhubLocationId, operatorId: operator.id, deviceId: dev.id },
        });
      }
    }

    const upsertUser = async (u: { username: string; password?: string | null; firstName?: string; lastName?: string; role: UserRole; mevUserName: string; externalId?: string | null }) => {
      const passwordHash = u.password ? await bcrypt.hash(u.password, 12) : null;
      const existing = await prisma.sEVUser.findUnique({ where: { username: u.username } });
      if (existing && existing.operatorId !== operator.id) fail(`username ${u.username} belongs to another operator`);
      const data = { firstName: u.firstName ?? '', lastName: u.lastName ?? '', role: u.role, mevUserName: u.mevUserName, externalId: u.externalId ?? null, passwordHash, isActive: true };
      return existing ? prisma.sEVUser.update({ where: { id: existing.id }, data }) : prisma.sEVUser.create({ data: { ...data, operatorId: operator.id, username: u.username } });
    };

    const admin = await upsertUser({ username: seed.admin.username, password: seed.admin.password, firstName: seed.admin.firstName, lastName: seed.admin.lastName, role: UserRole.ADMIN, mevUserName: seed.admin.mevUserName ?? seed.admin.username });
    const auto = await upsertUser({ username: `foodhub-auto.${operator.id.slice(0, 8)}`, password: null, firstName: 'Food Hub', lastName: 'auto', role: UserRole.SYSTEM, mevUserName: FOODHUB_AUTO, externalId: `foodhub:${FOODHUB_AUTO}` });
    const staff = [];
    for (const s of seed.staff ?? []) {
      if ((s.password ?? '').length < 12) fail(`staff ${s.username}: password must be 12+ characters`);
      staff.push(await upsertUser({ username: s.username, password: s.password, firstName: s.firstName, lastName: s.lastName, role: (s.role as UserRole) ?? UserRole.CASHIER, mevUserName: s.mevUserName ?? s.username, externalId: s.externalId ?? null }));
    }

    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      ok: true,
      environment: env,
      operatorId: operator.id,
      devices,
      users: { admin: admin.id, foodhubAuto: auto.id, staff: staff.map((s) => s.id) },
      next: 'log in as the admin, then POST /api/devices/:id/certificate for each device (CRT + UTL)',
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
