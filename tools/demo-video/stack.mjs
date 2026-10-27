#!/usr/bin/env node
/**
 * Demo stack for the recorded walkthrough (tools/demo-video/record.mjs), WITHOUT Docker:
 *   embedded PostgreSQL → preflight + migrate → seed (placeholders) → backend in SIMULATOR mode →
 *   CRT + UTL for the device → dashboard (next build + start) — then it STAYS UP until Ctrl+C / SIGTERM.
 *
 *   cd tools/local-run && npm install          (embedded-postgres lives there)
 *   node tools/demo-video/stack.mjs
 *
 * Everything (database, secrets, logs) lives in a temporary folder OUTSIDE the repository (QCMEV_DEMO_DIR, default
 * <os temp>/qcmev-demo-*). It writes <dir>/demo.json (URLs + the demo logins) for record.mjs. Secrets are random per
 * run and identity values are obvious placeholders: this is NOT Revenu Québec's DEV or ESSAI environment.
 * Ports: QCMEV_PG_PORT (55433), QCMEV_PORT (3101), QCMEV_WEB_PORT (3100).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const backend = path.join(repo, 'backend');
const frontend = path.join(repo, 'frontend');
// embedded-postgres is installed by tools/local-run (one dependency set for both local tools)
const EmbeddedPostgres = createRequire(path.join(repo, 'tools', 'local-run', 'package.json'))('embedded-postgres').default;

const PG_PORT = Number(process.env.QCMEV_PG_PORT ?? 55433);
const PORT = Number(process.env.QCMEV_PORT ?? 3101);
const WEB_PORT = Number(process.env.QCMEV_WEB_PORT ?? 3100);
const work = process.env.QCMEV_DEMO_DIR ? path.resolve(process.env.QCMEV_DEMO_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'qcmev-demo-'));
if (path.resolve(work).toLowerCase().startsWith(repo.toLowerCase())) {
  console.error('QCMEV_DEMO_DIR must be outside the repository');
  process.exit(1);
}
fs.mkdirSync(work, { recursive: true });
// As root, embedded-postgres runs initdb as an unprivileged user: it must be able to reach and create its data folder.
if (process.getuid?.() === 0) {
  fs.chmodSync(work, 0o777); // initdb creates and owns pgdata itself; the secret files stay 0600
}

const t0 = Date.now();
const log = (m) => console.log(`[demo-stack ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const hex = (n) => crypto.randomBytes(n).toString('hex');

const secrets = {
  JWT_SECRET: hex(32),
  PRIVATE_KEY_ENCRYPTION_KEY: hex(32),
  ADMIN_PASSWORD: `Adm-${hex(8)}`,
  STAFF_PASSWORD: `Stf-${hex(8)}`,
  PG_PASSWORD: hex(16),
};
const seed = {
  operator: {
    name: 'Restaurant Démonstration (données fictives)',
    neq: '0000000000',
    noTPS: '000000000RT0001',
    noTVQ: '0000000000TQ0001',
    address: '1 rue Exemple',
    city: 'Montréal QC',
  },
  admin: { username: 'gerant-demo', password: secrets.ADMIN_PASSWORD, firstName: 'Gérant', lastName: 'Démo' },
  staff: [{ username: 'caissier-demo', password: secrets.STAFF_PASSWORD, mevUserName: 'caissier-demo', role: 'CASHIER' }],
  devices: [{ serialNumber: 'DEMO-CAISSE-1', name: 'Caisse 1', fileNumber: 'ER0000', authorizationCode: 'XXXX-XXXX', description: 'Caisse 1 (démo)' }],
};
const seedFile = path.join(work, 'seed.json');
fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2), { mode: 0o600 });

const DATABASE_URL = `postgresql://qcmev:${secrets.PG_PASSWORD}@127.0.0.1:${PG_PORT}/qcmev_demo`;
const env = {
  ...process.env,
  DATABASE_URL,
  PORT: String(PORT),
  NODE_ENV: 'production',
  MEV_ENVIRONMENT: 'SIMULATOR',
  JWT_SECRET: secrets.JWT_SECRET,
  PRIVATE_KEY_ENCRYPTION_KEY: secrets.PRIVATE_KEY_ENCRYPTION_KEY,
  MEV_SIMULATOR_STATE_DIR: path.join(work, 'simulator'),
  MEV_OFFLINE_FLUSH_SECONDS: '5',
  QCMEV_RATE_LIMIT_PER_SECOND: '1000',
  QCMEV_RATE_LIMIT_PER_MINUTE: '100000',
  SEED_FILE: seedFile,
  FRONTEND_URL: `http://127.0.0.1:${WEB_PORT}`,
};

function run(name, cmd, cwd, extra = {}) {
  log(name);
  const r = spawnSync(cmd, { cwd, env: { ...env, ...extra }, stdio: 'inherit', shell: true });
  if (r.status !== 0) throw new Error(`${name} failed (exit ${r.status})`);
}
const children = [];
function start(name, cmd, args, cwd, extra = {}) {
  const fd = fs.openSync(path.join(work, `${name}.log`), 'a');
  const p = spawn(cmd, args, { cwd, env: { ...env, ...extra }, stdio: ['ignore', fd, fd] });
  p.on('exit', (code) => log(`${name} exited (${code})`));
  children.push(p);
  return p;
}
async function waitUrl(url, timeoutMs = 90_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} did not answer 200`);
}
async function api(method, p, body, token) {
  const r = await fetch(`http://127.0.0.1:${PORT}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

const pg = new EmbeddedPostgres({
  databaseDir: path.join(work, 'pgdata'),
  user: 'qcmev',
  password: secrets.PG_PASSWORD,
  port: PG_PORT,
  persistent: false,
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: (m) => process.stderr.write(`[pg] ${m}\n`),
});

async function shutdown(code = 0) {
  for (const c of children) if (c.exitCode === null) c.kill();
  await new Promise((r) => setTimeout(r, 1500));
  await pg.stop().catch(() => {});
  log(`stopped (work folder kept: ${work})`);
  process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/** A port already taken (an earlier demo still running) would silently serve the wrong stack: refuse to start. */
async function portFree(port) {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer().once('error', () => resolve(false)).once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

try {
  for (const port of [PG_PORT, PORT, WEB_PORT]) {
    if (!(await portFree(port))) throw new Error(`port ${port} is already in use (stop the earlier demo first)`);
  }
  log(`work folder: ${work}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('qcmev_demo');
  if (!process.argv.includes('--skip-build')) run('backend build', 'npm run build --silent', backend);
  run('database preflight', 'npm run db:preflight --silent', backend);
  run('prisma migrate deploy', 'npx prisma migrate deploy', backend);
  run('seed (placeholders)', 'npm run seed:operator --silent', backend);

  start('backend', process.execPath, ['dist/main.js'], backend);
  await waitUrl(`http://127.0.0.1:${PORT}/api/health/ready`);
  log('backend ready (SIMULATOR)');

  const login = await api('POST', '/auth/login', { username: seed.admin.username, password: seed.admin.password });
  if (login.status !== 200) throw new Error(`login failed (${login.status})`);
  for (const d of (await api('GET', '/devices', null, login.body.accessToken)).body) {
    const c = await api('POST', `/devices/${d.id}/certificate`, {}, login.body.accessToken);
    if (c.status !== 201) throw new Error(`certificate ${d.serialNumber}: ${JSON.stringify(c.body).slice(0, 300)}`);
    log(`CRT + UTL ${d.serialNumber} → IDAPPRL ${c.body.mevDeviceId}, ${c.body.usersRegistered} users`);
  }

  // The dashboard proxies /api to the backend; the rewrite target is baked at build time.
  const webEnv = { API_INTERNAL_URL: `http://127.0.0.1:${PORT}`, NODE_ENV: 'production' };
  if (!process.argv.includes('--skip-web-build')) run('dashboard build', 'npx next build', frontend, webEnv);
  start('dashboard', 'npx', ['next', 'start', '-p', String(WEB_PORT)], frontend, webEnv);
  await waitUrl(`http://127.0.0.1:${WEB_PORT}/login`);

  const demo = {
    web: `http://127.0.0.1:${WEB_PORT}`,
    api: `http://127.0.0.1:${PORT}/api`,
    admin: { username: seed.admin.username, password: seed.admin.password },
    staff: { username: seed.staff[0].username, password: seed.staff[0].password },
    work,
  };
  fs.writeFileSync(path.join(work, 'demo.json'), JSON.stringify(demo, null, 2), { mode: 0o600 });
  log(`READY → ${demo.web}  (logins in ${path.join(work, 'demo.json')}) — Ctrl+C to stop`);
} catch (e) {
  log(`FAILED: ${e.message}`);
  await shutdown(1);
}
