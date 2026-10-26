#!/usr/bin/env node
/**
 * Local end-to-end run WITHOUT Docker (Windows, macOS, Linux):
 *   embedded PostgreSQL → prisma migrate deploy → migration drift check → SW-77 preparation suite (database,
 *   in-process API + simulator) → seed (placeholders) → backend in SIMULATOR mode → CRT + UTL for each device →
 *   Jest unit tests → 12 internal scenarios → Food Hub contract e2e → backend restart → replay checks →
 *   login rate limit → teardown.
 *
 *   cd tools/local-run && npm install && node run-local.mjs [--keep] [--skip-build] [--skip-unit]
 *
 * Everything (database, secrets, simulator state, logs, report) lives in a temporary folder OUTSIDE the repository
 * (QCMEV_LOCAL_DIR, default <os temp>/qcmev-local-*). Secrets are random per run; identity values are obvious
 * placeholders. Ports: QCMEV_PG_PORT (55432), QCMEV_PORT (3001).
 */
import EmbeddedPostgres from 'embedded-postgres';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const backend = path.join(repo, 'backend');
const args = new Set(process.argv.slice(2));
const KEEP = args.has('--keep');
const SKIP_BUILD = args.has('--skip-build');
const SKIP_UNIT = args.has('--skip-unit');
const PG_PORT = Number(process.env.QCMEV_PG_PORT ?? 55432);
const PORT = Number(process.env.QCMEV_PORT ?? 3001);
const work = process.env.QCMEV_LOCAL_DIR ? path.resolve(process.env.QCMEV_LOCAL_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'qcmev-local-'));
if (path.resolve(work).toLowerCase().startsWith(repo.toLowerCase())) {
  console.error('QCMEV_LOCAL_DIR must be outside the repository');
  process.exit(1);
}
fs.mkdirSync(work, { recursive: true });

const steps = [];
const t0 = Date.now();
const log = (m) => console.log(`[local-run ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const hex = (n) => crypto.randomBytes(n).toString('hex');

// ─── Secrets and placeholders (never in the repository) ────────────────────
const secrets = {
  JWT_SECRET: hex(32),
  PRIVATE_KEY_ENCRYPTION_KEY: hex(32),
  QCMEV_FOODHUB_SECRET: hex(32),
  QCMEV_FOODHUB_SECRET_PREVIOUS: hex(32),
  ADMIN_PASSWORD: `Adm-${hex(12)}`,
  STAFF_PASSWORD: `Stf-${hex(12)}`,
  PG_PASSWORD: hex(16),
};
const placeholders = { neq: '0000000000', noTPS: '000000000RT0001', noTVQ: '0000000000TQ0001', fileA: 'ER0000', fileB: 'ER0001', auth: 'XXXX-XXXX' };
fs.writeFileSync(path.join(work, 'e2e.env'), Object.entries(secrets).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
const seed = {
  operator: { name: 'Restaurant Démo E2E (données fictives)', neq: placeholders.neq, noTPS: placeholders.noTPS, noTVQ: placeholders.noTVQ, address: '1 rue Exemple', city: 'Montréal QC' },
  admin: { username: 'admin-e2e', password: secrets.ADMIN_PASSWORD, firstName: 'Admin', lastName: 'E2E' },
  staff: [{ username: 'staff-e2e', password: secrets.STAFF_PASSWORD, mevUserName: 'staff-e2e', role: 'CASHIER', externalId: 'foodhub:staff-e2e' }],
  devices: [
    { serialNumber: 'E2E-A', fileNumber: placeholders.fileA, authorizationCode: placeholders.auth, foodhubLocationId: 'E2E_A', description: 'Cuisine A (test)' },
    { serialNumber: 'E2E-B', fileNumber: placeholders.fileB, authorizationCode: placeholders.auth, foodhubLocationId: 'E2E_B', description: 'Cuisine B (test)' },
  ],
  foodhubTenantId: 'takatak',
};
const seedFile = path.join(work, 'seed.json');
fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2), { mode: 0o600 });

const DATABASE_URL = `postgresql://qcmev:${secrets.PG_PASSWORD}@127.0.0.1:${PG_PORT}/qcmev_e2e`;
const backendLog = path.join(work, 'backend.log');
const report = path.join(work, 'mev-e2e-report.json');
const baseEnv = {
  ...process.env,
  DATABASE_URL,
  PORT: String(PORT),
  NODE_ENV: 'test',
  MEV_ENVIRONMENT: 'SIMULATOR',
  JWT_SECRET: secrets.JWT_SECRET,
  PRIVATE_KEY_ENCRYPTION_KEY: secrets.PRIVATE_KEY_ENCRYPTION_KEY,
  QCMEV_FOODHUB_ENABLED: 'true',
  QCMEV_FOODHUB_SECRET: secrets.QCMEV_FOODHUB_SECRET,
  QCMEV_FOODHUB_SECRET_PREVIOUS: secrets.QCMEV_FOODHUB_SECRET_PREVIOUS,
  MEV_SIMULATOR_STATE_DIR: path.join(work, 'simulator'),
  MEV_OFFLINE_FLUSH_SECONDS: '5',
  LOG_LEVEL: 'log',
  // Every script below talks from 127.0.0.1: the per-IP tiers are raised for the run (their defaults, 10/s and
  // 100/min, are unit-tested); the login limit (10/min) still applies and is checked at the end.
  QCMEV_RATE_LIMIT_PER_SECOND: '1000',
  QCMEV_RATE_LIMIT_PER_MINUTE: '100000',
  SEED_FILE: seedFile,
};

function run(name, cmd, cwd, env = baseEnv) {
  log(`${name}: ${cmd}`);
  const started = Date.now();
  const r = spawnSync(cmd, { cwd, env, stdio: 'inherit', shell: true });
  const ok = r.status === 0;
  steps.push({ step: name, ok, seconds: Math.round((Date.now() - started) / 1000), exitCode: r.status });
  if (!ok) log(`${name} FAILED (exit ${r.status})`);
  return ok;
}

let server = null;
function startBackend() {
  const fd = fs.openSync(backendLog, 'a');
  server = spawn(process.execPath, ['dist/main.js'], { cwd: backend, env: baseEnv, stdio: ['ignore', fd, fd] });
  server.on('exit', (code) => log(`backend exited (${code})`));
}
async function stopBackend() {
  if (!server || server.exitCode !== null) return;
  const done = new Promise((r) => server.once('exit', r));
  server.kill();
  await Promise.race([done, new Promise((r) => setTimeout(r, 10_000))]);
}
async function waitHealth(timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.status === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
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
  // UTF-8 like the production PostgreSQL image (Windows would otherwise pick WIN1252 and refuse « → », etc.).
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: () => {},
  onError: (m) => process.stderr.write(`[pg] ${m}\n`),
});

let exitCode = 0;
try {
  log(`work folder: ${work}`);
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('qcmev_e2e');
  steps.push({ step: 'embedded postgres 16', ok: true });
  log(`PostgreSQL ready on ${PG_PORT}`);

  const npx = 'npx';
  if (!SKIP_BUILD && !run('build', 'npm run build', backend)) throw new Error('build failed');
  if (!run('prisma migrate deploy', `${npx} prisma migrate deploy`, backend)) throw new Error('migrate failed');
  if (!run('migration drift (database = schema.prisma)', `${npx} prisma migrate diff --from-url "${DATABASE_URL}" --to-schema-datamodel prisma/schema.prisma --exit-code`, backend)) exitCode = 1;
  if (!run('SW-77 preparation suite (database, in-process API + simulator)', 'npm run test:integration --silent', backend, { ...baseEnv, QCMEV_DB_TESTS: '1' })) exitCode = 1;
  if (!run('seed:operator (placeholders)', 'npm run seed:operator', backend)) throw new Error('seed failed');

  startBackend();
  if (!(await waitHealth())) throw new Error(`backend did not start (see ${backendLog})`);
  steps.push({ step: 'backend up (SIMULATOR, Food Hub enabled)', ok: true });

  const login = await api('POST', '/auth/login', { username: 'admin-e2e', password: secrets.ADMIN_PASSWORD });
  if (login.status !== 200) throw new Error(`admin login failed (${login.status})`);
  const token = login.body.accessToken;
  const devices = (await api('GET', '/devices', null, token)).body;
  for (const d of devices) {
    const c = await api('POST', `/devices/${d.id}/certificate`, {}, token);
    const ok = c.status === 201 && c.body.usersRegistered >= 3 && c.body.usersFailed === 0;
    steps.push({ step: `CRT + UTL ${d.serialNumber}`, ok, detail: ok ? `IDAPPRL ${c.body.mevDeviceId}, ${c.body.usersRegistered} users` : JSON.stringify(c.body).slice(0, 300) });
    if (!ok) throw new Error(`certificate for ${d.serialNumber} failed: ${JSON.stringify(c.body).slice(0, 300)}`);
    log(`CRT ${d.serialNumber} → IDAPPRL ${c.body.mevDeviceId}; UTL users ${c.body.usersRegistered}`);
  }

  if (!SKIP_UNIT && !run('jest unit tests', 'npm test --silent', backend)) exitCode = 1;

  const tsnode = `${npx} ts-node --transpile-only --project tsconfig.json`;
  const scenarioEnv = { ...baseEnv, BACKEND_URL: `http://127.0.0.1:${PORT}`, QCMEV_ADMIN_USER: 'admin-e2e', QCMEV_ADMIN_PASSWORD: secrets.ADMIN_PASSWORD, QCMEV_SIM_CONTROL: '1' };
  if (!run('internal scenarios (scripts/run-test-cases.ts)', `${tsnode} ../scripts/run-test-cases.ts`, backend, scenarioEnv)) exitCode = 1;

  const forbidden = [...Object.values(placeholders), ...Object.values(secrets)].join(',');
  const e2eEnv = {
    ...scenarioEnv,
    NODE_PATH: path.join(backend, 'node_modules'),
    FOODHUB_TENANT: 'takatak',
    FOODHUB_LOCATIONS: 'E2E_A,E2E_B',
    QCMEV_E2E_STATE: path.join(work, 'e2e-state.json'),
    QCMEV_E2E_REPORT: report,
    QCMEV_E2E_FORBIDDEN: forbidden,
    BACKEND_LOG: backendLog,
  };
  if (!run('Food Hub contract e2e (main)', `${tsnode} ../scripts/verify-foodhub-e2e.ts --phase=main`, backend, e2eEnv)) exitCode = 1;

  log('restarting the backend (replay after restart)');
  await stopBackend();
  startBackend();
  if (!(await waitHealth())) throw new Error('backend did not restart');
  if (!run('Food Hub contract e2e (after restart)', `${tsnode} ../scripts/verify-foodhub-e2e.ts --phase=after-restart`, backend, e2eEnv)) exitCode = 1;

  // Rate limit (ThrottlerModule): the 11th login attempt within a minute from one IP answers 429.
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await api('POST', '/auth/login', { username: 'admin-e2e', password: 'wrong-password' })).status);
  const limited = codes.slice(0, 10).every((c) => c === 401) && codes[10] === 429;
  steps.push({ step: 'rate limit: 11th login in a minute → 429', ok: limited, detail: limited ? undefined : codes.join(',') });
  if (!limited) exitCode = 1;
} catch (e) {
  exitCode = 1;
  log(`ERROR: ${e instanceof Error ? e.message : e}`);
  steps.push({ step: 'run', ok: false, detail: e instanceof Error ? e.message : String(e) });
} finally {
  await stopBackend();
  try {
    await pg.stop();
  } catch {
    /* already stopped */
  }
  const summary = { ok: exitCode === 0 && steps.every((s) => s.ok), at: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), work: KEEP ? work : '(deleted)', steps };
  if (fs.existsSync(report)) summary.e2e = JSON.parse(fs.readFileSync(report, 'utf8'));
  const out = process.env.QCMEV_REPORT_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(summary, null, 2));
  console.log('\n──────── local run summary ────────');
  for (const s of steps) console.log(`${s.ok ? 'OK  ' : 'FAIL'}  ${s.step}${s.detail ? `  (${s.detail})` : ''}`);
  console.log(`result: ${summary.ok ? 'ALL GREEN' : 'FAILED'} in ${summary.seconds}s${out ? `; summary written to ${out}` : ''}`);
  if (!KEEP) fs.rmSync(work, { recursive: true, force: true });
  else console.log(`kept: ${work} (contains random test secrets; delete it when done)`);
  process.exit(summary.ok ? 0 : 1);
}
