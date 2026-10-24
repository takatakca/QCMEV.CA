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
| 5 | Operator registration flow (public register, UTL headers, MEV user sync) | `operators/*`, `auth.service.ts`, `mev-web.service.ts`, `mev-time.ts` | ✅ done (tested live) |
| 6 | Certificate lifecycle + nightly renewal job | `certificates/certificate-lifecycle.service.ts` (new), `certificates.*`, simulator | ✅ done (tested live) |
| 7 | Full build verification (backend + frontend) | — | ✅ done |

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

- 2026-10-24 — Task 5 done, **tested live** against Postgres + built-in simulator.
  - `operators.controller.ts`: guards per route; `POST /api/operators/register` is public (was 401).
  - `operators/dto/register-operator.dto.ts` (new): class-validator DTOs — NEQ 10 digits, sector RST/TRP, password ≥ 8, etc. `UpdateOperatorDto` whitelists editable fields (old `update()` passed `mevEnvironment`, a non-existent field, via `as any`).
  - `operators.service.register()`: operator + first ADMIN created in ONE nested insert (atomic), 409 on duplicate NEQ/username, audit `USER_REGISTERED`.
  - `auth.service.ts`: `createUser()` validates role/username/password, audits, never returns `passwordHash`; new `registerUserWithMev(userId)` + `syncMevUsers(operatorId)`; UTL uses the shared header.
  - New `POST /api/operators/users/sync-mev` (JWT).
  - `MevWebService.buildHeader()` = single header builder (Québec local date/time). Used by TRX, UTL, DOC (CRT in task 6).
  - Live results: invalid body → 400 with messages; register → 201; dup NEQ → 409; login OK; cashier → mevUserId from simulator, no hash; device with model/firmware; sync-mev registers admin, 2nd call no-op.
  - Note: register is public by design (first-time setup). Consider gating it in PRODUCTION (invite code / env flag) — product decision for Takatak.

- 2026-10-24 — Task 6 done, **full SEV lifecycle tested live** (Postgres 16 + simulator).
  - New `CertificateLifecycleService`: `requestCertificate(operatorId, deviceId)` → CSR → CRT (real header; NEQ/auth code/sector from the Operator record, not the body) → store → audit `CERTIFICATE_REQUESTED/RECEIVED` → `syncMevUsers()` automatically.
  - Nightly job `renewExpiringCertificates()` at 03:00 America/Toronto; window `CERT_RENEWAL_DAYS` (default 30); renews on the same device (`Certificate.deviceId`, new column); one failure doesn't block others; failures audited (CRITICAL if already expired); re-entrancy guard.
  - Endpoints: `POST /api/certificates/request {deviceId}`, new `POST /api/certificates/renew`; `GET /api/certificates/expiring` now scoped to the caller's operator (**was leaking every operator's certs**).
  - **Finding/fix (crash):** CSR generation used `{shortName:'serialNumber'}` → forge throws inside the keygen callback → uncaught → **the whole API process died** on every certificate request. Fixed attribute + try/catch → reject.
  - **Finding/fix:** simulator returned a fake non-X.509 PEM → storing it always failed. Simulator now signs a real X.509 from the CSR with an in-memory CA; validity `SIMULATOR_CERT_VALIDITY_DAYS` (default 365, set 10 to test renewal).
  - **Finding/fix:** JWT strategy returned `{id}` but `transactions.controller` reads `req.user.sub` (5 places) → **every sale/cancel/correction via the API failed (500)**. Strategy now returns both.
  - Init migration regenerated again (Certificate.deviceId + index) and re-verified: deploy OK, zero drift.
  - Live run: register → login → device → certificate (admin auto-synced) → renew → online sale ACCEPTED (`SIM-20261024-000001`) → operator env set to unreachable → 2 sales `QUEUED_OFFLINE`, device offline → back to simulator → flush `{submitted:2, remaining:0}` → all 3 `INVOICED/ACCEPTED` → device online. Audit: OFFLINE_MODE_ACTIVATED → BATCH_SUBMITTED → OFFLINE_MODE_DEACTIVATED. Nightly job run directly → renewed.

- 2026-10-24 — Task 7 + extra findings done.
  - **Frontend did not compile** (2 type errors): settings page called `requestCertificate()` without the device id → now uses the operator's first active device (clear message if none); `getDailySummary()` client required a `deviceId` the backend never takes → signature aligned (`date?` only). `next build` ✅ (10 pages), `tsc` ✅.
  - All 18 frontend API calls verified against the backend's mapped routes — 0 mismatches.
  - ANN/COR/NDC now send the original's MEV transaction number. Tenant isolation added for devices and for sale creation.
  - Final: backend `nest build` ✅, frontend `next build` ✅, migration ✅ on Postgres 16.

## ▶ NEXT SESSION — start here
1. **Transactions tenant isolation (security, do first):** `GET /transactions/:id/receipt`, `POST /transactions/:id/cancel`, `/items`, `/items/:itemId/remove|price` load by id without checking `operatorId` (see `transactions.service.ts` ~L326, 334, 414, 441). Same pattern as `DevicesService.assertOwned()`.
2. Edge case: cancelling a sale that is still `QUEUED_OFFLINE` → original has no MEV number yet → `numeroTransactionOriginal` undefined in the queued ANN. Option: build the payload at flush time, or block until accepted.
3. Run `docker compose up --build` on a machine with Docker (cloud sandbox has none) — expected to work after task 4 fixes. If the DB was created with the old 2024 migration: `docker compose down -v` first.
4. Product decision: gate public `POST /api/operators/register` in PRODUCTION (invite code / env flag)?
5. Replace `@Body() dto: any` on `POST /devices`, `POST /operators/users`, `POST /transactions` with class-validator DTOs (pattern: `operators/dto/register-operator.dto.ts`).
6. External: Revenu Québec TESTING credentials → SW-77 certification run → submission.

### Findings to fix next (found while reading, not yet done)
- [x] ~~Civil date uses UTC~~ → fixed in task 5 (`mev-web/mev-time.ts`, `America/Toronto`).
- [x] ~~`numeroTransactionOriginal` sent our internal UUID~~ → now the original's MEV number (same-operator lookup).
- [x] ~~`POST /operators/register` returns 401~~ → fixed task 5
- [x] ~~UTL/CRT send empty header~~ → fixed tasks 5–6.
- [x] ~~`POST /operators/users` returns `passwordHash`~~ → fixed task 5
- [x] ~~No way to re-send UTL~~ → `POST /api/operators/users/sync-mev` + `AuthService.syncMevUsers()`; auto-call after cert storage → task 6
- [x] ~~Tenant isolation on devices~~ → `DevicesService.assertOwned()` on get/update/offline-status/flush; sales require device + user of the caller's operator.


## 2026-10-24 — Dossier administratif Revenu Québec (priorité utilisateur)

**Avant de refaire les PDF ou de reprendre le code : lire [docs/revenu-quebec/REPRISE.md](docs/revenu-quebec/REPRISE.md).**

L’utilisateur demande désormais toutes les notes dans GitHub et autorise la poursuite de l’envoi à Revenu Québec. Deux originaux lus; SW-10 corrigé (copie avec signature manuscrite du concepteur conservée + copie pour nouvelle signature), résolution préparée et brouillon `.eml` produit. Aucun courriel envoyé : aucun outil/compte de messagerie disponible; résolution non signée; aucun certificat de signature numérique fourni. Le journal détaillé distingue les résultats vérifiés des affirmations de l’ancien agent et donne les étapes restantes. Le commit annoncé `fbcc91f` n’a pas été retrouvé dans les branches distantes accessibles.

La branche distante `feature/official-protocol-foodhub` (`903e9db`) contient des travaux techniques plus récents que ce main, dont CERTIFICATION.md et SPEC_GAPS.md. Ne pas reprendre aveuglément l’ancienne liste technique de ce HANDOFF sans lire son état de relève sur cette branche. Aucune fusion de code ni validation officielle effectuée dans cette session.


### Suivi administratif — compte et classement

Dernière demande : **takatak.ca@gmail.com** comme expéditeur, suivi des réponses et archivage dans le OneDrive associé. `docs/revenu-quebec/ENVOI-ET-SUIVI.md` décrit le dossier prêt à envoyer et les règles de classement / reprise. Lettre texte + PDF et `.eml` mis à jour. Aucun outil Gmail ou OneDrive exposé : aucun envoi, dépôt ou surveillance automatique actif. Ne pas demander de nouveau les coordonnées ni refaire les documents existants.
