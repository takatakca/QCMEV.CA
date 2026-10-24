# HANDOFF — QCMEV.CA work log

> Read this FIRST before doing any work. Every step is committed + pushed
> as it finishes, so the git log and this file are the source of truth.
> Update the status column and the log at the bottom after each step.

## Baseline (start of this session — 2026-10-24)

- Commit `40625e4` — "fix: resolve all TypeScript build errors + add initial Prisma migration"
- `backend` builds clean (`npm run build`, 0 TS errors) per previous session
- Initial migration: `backend/prisma/migrations/20261024000000_init/` (was 20241024…, renamed in task 4)

## Task list (priority order)

| # | Task | Files | Status |
|---|------|-------|--------|
| 1 | Offline mode semantics (SW-76 §4.7) — see log | `schema.prisma`, `offline-queue.service.ts`, `transactions.service.ts`, `mev-web.service.ts` | ✅ done |
| 2 | Device model: `offlineSince` + `name`/`model`/`firmwareVersion` | `schema.prisma`, `devices.service.ts` | ✅ done |
| 3 | Runtime validation of TRX payloads (replaces `as unknown as` cast) | `mev-web/payload-validator.ts` (new), `mev-web.service.ts` | ✅ done |
| 4 | Migration renamed/regenerated + Docker fixes (see log) | `prisma/migrations/*`, both Dockerfiles, both compose files | ✅ done |
| 5 | Operator registration endpoint `POST /api/operators/register` | `backend/src/operators/*` | ⏳ pending |
| 6 | Certificate renewal cron (auto-renew before `validTo`) | `backend/src/certificates/*`, `backend/src/app.module.ts` | ⏳ pending |
| 7 | Full build verification (backend + frontend) | — | ⏳ pending |

### Blocked on outside parties (cannot be done in code)
- SW-77 certification run needs Revenu Québec TESTING credentials
- Final submission to Revenu Québec

## Log
- 2026-10-24 — Session started, repo cloned, HANDOFF.md created.
- 2026-10-24 — Tasks 1–3 done, backend build green. Details:
  - **Finding:** `activateOfflineMode()` was never called anywhere — a network failure marked the sale REJECTED and threw. Offline mode never happened.
    - Fix: `transactions.service.ts` now queues the sale + flags the device offline on transient errors (network/timeout/5xx, via `isTransientMevError()` in `mev-web.dto.ts`). 4xx business rejections still REJECTED + thrown.
  - **Finding:** queued transactions were resubmitted but the `Transaction` row was never updated (no MEV number / QR / certified data).
    - Fix: `OfflineQueue.transactionId` added; `submitOfflineBatch()` writes the MEV response back to the transaction.
  - `submitOfflineBatch()` now stops at the first transient failure (keeps chronological order) and never marks a queued fiscal record FAILED for network reasons; 4xx/invalid payload → FAILED + transaction REJECTED + `MEV_SUBMISSION_FAILED` audit.
  - Device goes back online only when its queue is empty. `offlineSince` set on activation, cleared on recovery; `lastSyncAt` set on recovery. `OFFLINE_MODE_ACTIVATED/DEACTIVATED` audit events now logged (enum values existed but were unused).
  - `BATCH_SUBMITTED` audit kept — correct for the flush event itself.
  - **Finding:** `devices.service.update()` passed `name`/`firmwareVersion` with `as any` → would crash at runtime. Now explicit whitelist + fields exist in schema. `register()` validates `deviceType`.
  - Payload validator also runs on LIVE submissions, not just the queue.
  - Schema changed → migration regenerated in task 4.

- 2026-10-24 — Task 4 done.
  - Migration folder → `20261024000000_init`, SQL regenerated from final schema (`prisma migrate diff --from-empty`).
  - **Verified on a real PostgreSQL 16**: `prisma migrate deploy` applies cleanly, `migrate diff` vs schema = no drift.
  - ⚠️ If anyone already ran `docker compose up` with the OLD 2024 migration: dev DB only → `docker compose down -v` then up again.
  - **Finding/fix:** `prisma` CLI was a devDependency → stripped from the prod image (`npm ci --omit=dev`) → `migrate deploy` could not run. Now a pinned prod dependency (`prisma` + `@prisma/client` = 5.22.0 exact).
  - Backend Dockerfile: `apk add openssl` (Prisma engine needs it on Alpine); CMD now `prisma migrate deploy && node dist/main` (removed duplicate from compose).
  - **Finding/fix:** simulator URL defaulted to `localhost:3002` but the simulator is a controller in the backend → now `http://localhost:3001/api/mev-simulator` (code default, compose, .env.example, README).
  - **Finding/fix:** frontend Docker build copied `/app/public` which didn't exist → added `frontend/public/.gitkeep`.
  - **Finding/fix:** frontend `/api` rewrite pointed to `localhost:3001` = the frontend container itself. Rewrites are baked at build → new `API_INTERNAL_URL` build arg (`http://backend:3001`) in Dockerfile + compose.
  - `docker-compose.dev.yml`: build `target: builder` (prod stage has no nest CLI / next dev deps, hot reload could not start).
  - Note: `MEV_ENVIRONMENT` env var is not read by the code — the active env comes from `Operator.environment` in the DB.

- 2026-10-24 — **CRITICAL fix: the API could not start.** `class-validator` / `class-transformer` were missing → Nest exits at boot (`ValidationPipe`). Added to dependencies. Verified: API boots against Postgres 16, `/api/mev-simulator/health` → 200.
  - Required env at boot: `DATABASE_URL`, `PRIVATE_KEY_ENCRYPTION_KEY` (getOrThrow), `JWT_SECRET`.
  - **Local test DB recipe** (no Docker in the cloud sandbox): `/usr/lib/postgresql/16/bin/initdb` as user `postgres` in `/var/tmp/qcmev-pgtest`, port 55432, user `takatak`, trust auth → `DATABASE_URL=postgresql://takatak@127.0.0.1:55432/qcmev`.

### Findings to fix next (found while reading, not yet done)
- [ ] **Civil date uses UTC** — `getCivilDate()` in `transactions.service.ts` uses `toISOString()`. A sale at 21:00 in Québec (EDT) gets tomorrow's date. Must use `America/Toronto`. Same for `heureDebut` (`toTimeString()` = container TZ, usually UTC).
- [ ] **`numeroTransactionOriginal` sends our internal UUID** (`relatedTransactionId`) instead of the original's MEV transaction number — affects ANN / COR / NDC.
- [ ] **`POST /operators/register` returns 401** (verified live) — class-level `JwtAuthGuard` → first operator can never register. → task 5
- [ ] **UTL + CRT send `entete: {} as any`** — header fields never filled; RQ would reject. CRT also uses `secteur ?? 'R'` (invalid) and NEQ from body. → task 5/6
- [ ] **`POST /operators/users` returns `passwordHash`** to the client. → task 5
- [ ] No way to re-send UTL after the certificate exists → users keep `mevUserId = null` → every TRX fails. → task 5
- [ ] **Tenant isolation:** `devices.controller` update/findById don't check the device belongs to `req.user.operatorId`.
