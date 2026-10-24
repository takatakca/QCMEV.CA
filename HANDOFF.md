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
| 8 | Transactions tenant isolation (receipt, cancel, post-invoice edits) | `transactions.*` | ✅ done (tested live) |
| 9 | ANN/COR/NDC of a sale still queued offline | `transactions.service.ts`, `mev-web.service.ts` | ✅ done (tested live) |
| 10 | class-validator DTOs replace `@Body() dto: any` | `transactions/dto`, `devices/dto`, `auth/dto` (new) | ✅ done (tested live) |

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

- 2026-10-24 — Tasks 8–10 done, **tested live** (Postgres 16 + simulator, two operators A/B).
  - **Tenant isolation:** receipt, receipt/text, cancel, items add/remove/price now scoped by `operatorId` (`TransactionsService.assertOwned()`, `ensureInvoiced(operatorId, id)`). Operator B on A's sale → 404 on all 6 routes.
  - **Finding/fix:** remove/price loaded the item by id only → any item of any transaction could be edited. Item must now belong to the transaction (else 404).
  - A cancellation can no longer be cancelled (400).
  - **Queued-original ANN/COR/NDC:** on an offline device the new record is queued behind the original and `numeroTransactionOriginal` is filled at flush time (`MevWebService.resolveOriginalReference()`); if the original is still queued the flush pauses, if it was rejected the item fails. On an online device → 409 (would have sent no reference). Original REJECTED → 400.
  - **Finding/fix:** flushing a queued sale that had been cancelled meanwhile reset it to `INVOICED`; it now stays `CANCELLED`.
  - DTOs: `CreateTransactionBodyDto` (+ nested items, taxCode FP/F/P/''), cancel/items/price DTOs, `RegisterDeviceDto`/`UpdateDeviceDto`, `CreateUserDto`. Bad bodies → 400. Frontend payloads still accepted (extra `location` on devices is stripped by the whitelist).
  - Live: sale ACCEPTED → B gets 404s → env unreachable → sale QUEUED → cancel QUEUED → flush `{submitted:2}` → original CANCELLED/ACCEPTED, ANN sent with `numeroTransactionOriginal = SIM-…-000002` (checked in `MevRequestLog`). 409 path checked with a 2nd online device.
  - Builds: backend `nest build` ✅, frontend `tsc` ✅.

## ▶ NEXT SESSION — start here
1. Run `docker compose up --build` on a machine with Docker (cloud sandbox has none) — expected to work after task 4 fixes. If the DB was created with the old 2024 migration: `docker compose down -v` first.
2. Product decision (Takatak): gate public `POST /api/operators/register` in PRODUCTION (invite code / env flag)? Not done — it changes who can sign up.
3. External: Revenu Québec TESTING credentials → SW-77 certification run → submission.

### Findings to fix next (found while reading, not yet done)
- [x] ~~Civil date uses UTC~~ → fixed in task 5 (`mev-web/mev-time.ts`, `America/Toronto`).
- [x] ~~`numeroTransactionOriginal` sent our internal UUID~~ → now the original's MEV number (same-operator lookup).
- [x] ~~`POST /operators/register` returns 401~~ → fixed task 5
- [x] ~~UTL/CRT send empty header~~ → fixed tasks 5–6.
- [x] ~~`POST /operators/users` returns `passwordHash`~~ → fixed task 5
- [x] ~~No way to re-send UTL~~ → `POST /api/operators/users/sync-mev` + `AuthService.syncMevUsers()`; auto-call after cert storage → task 6
- [x] ~~Tenant isolation on transactions~~ → task 8.
- [x] ~~Tenant isolation on devices~~ → `DevicesService.assertOwned()` on get/update/offline-status/flush; sales require device + user of the caller's operator.


---

## 2026-10-24 — Merge: core line onto the OFFICIAL MEV-WEB protocol layer (branch `feature/official-protocol-foodhub`, replaces PR #2)

Coordinated in issue #1 (core session keeps everything except the protocol layer; the Food Hub session owns the protocol
layer, the Food Hub integration and the certification package). Base = `origin/main` d2d0dd6 + `origin/claude/nice-cray-4fhekg`
1dc2849 (merged first, clean), then `origin/fix/functional-mev` (PR #2) merged and every conflict resolved by meaning.
Nothing above this entry was removed. The "▶ NEXT SESSION" list above is superseded by the one at the end of this entry.

**Rule applied:** every MEV-WEB message, header, signature, CSR, QR, receipt and transaction payload follows PR #2 (official
names `ENVIRN`, `APPRLINIT=SEV`, `IDSEV`, `IDVERSI`, `CODCERTIF`, `IDPARTN`, `VERSI`, `VERSIPARN`, `IDAPPRL`, `NOTPS`, `NOTVQ`;
bodies `reqCertif` / `reqUtil` / `reqTrans{transActu, transLot}` / `reqDoc`; ECDSA P-256; tags PROVEN / S1 / SPEC +
`SPEC_GAPS.md`). The invented layer (`typeRequete`, `codeSEV`, `entete`/`corps`, `codeAutorisation`, RSA-2048, guessed
`mev-web-*.revenuquebec.ca` URLs) is gone. Every behaviour of this log was kept and adapted:

| Core-line behaviour (tasks above) | Where it lives now |
|---|---|
| 1 Offline semantics + queue write-back + device offline/online + audits | `TransactionsService.submitDevice()`: batches (`transLot`) in chain order until the queue is empty; answer (`psiNoTrans`, `psiDatTrans`, errors) written back; device online again only when its queue is empty; `OFFLINE_MODE_ACTIVATED` → `BATCH_SUBMITTED` → `OFFLINE_MODE_DEACTIVATED` (with duration); never REJECTED for a network error; flush every `MEV_OFFLINE_FLUSH_SECONDS` + 48 h watchdog (`OfflineWatchService`, replaces `offline-queue.service.ts` and its 5-minute cron) |
| 2 Device `offlineSince`, `name` / `model` / `firmwareVersion` | `schema.prisma` Device; `POST /api/devices`, `PUT /api/devices/:id` (whitelist DTOs; file number + authorization code write-only, AES-GCM, frozen once certified) |
| 3 Runtime validation of TRX payloads | `mev-web/payload-validator.ts` rewritten for the official names: checked before storing (issue) and before sending (queue); a bad stored record is never sent → REJECTED + queue FAILED + CRITICAL audit, the flush stops there (chain order) |
| 4 Migration + Docker | ONE init migration `prisma/migrations/20261024000000_init` regenerated from the merged schema (`0001_init` of PR #2 removed); PR #2's production images (no secret, non-root, healthcheck) + new `dev` stages for `docker-compose.dev.yml` |
| 5 Public operator registration + DTOs, UTL headers, MEV user sync | `POST /api/operators/register` (public, atomic operator + first ADMIN, 409 on NEQ / username, 5/min, `QCMEV_PUBLIC_REGISTRATION=false` closes it; NEQ / `noTPS` / `noTVQ` formats, sector `RBC`, password ≥ 12); UTL = official `reqUtil` signed by each certified device; `POST /api/operators/users/sync-mev` (no-op on the 2nd call) |
| 6 Certificate lifecycle + nightly renewal | `certificates/certificate-lifecycle.service.ts`: CRT `AJO` (first) / `REM` + `noSerie` (renewal, signed with the current key, keeps IDAPPRL + chain, SPEC), then UTL for every user on that device; `@Cron('0 3 * * *', America/Montreal)`, window `CERT_RENEWAL_DAYS`, failures audited (CRITICAL if expired), re-entrancy guard; `POST /api/certificates/request`, `POST /api/certificates/renew`, `GET /api/certificates/active`, `GET /api/certificates/expiring` (scoped). Simulator: `REM` + `SIMULATOR_CERT_VALIDITY_DAYS` |
| JWT `sub` fix | one payload shape everywhere (`AuthUser.sub`), strategy re-checks the user |
| 8 Tenant isolation (devices, sales, receipts, items, cancel) | every `:id` route scoped by operator (404); an item must belong to the transaction in the route |
| 9 ANN / COR / NDC reference the original MEV number | official layer: a credit note / reprint / post-invoice change carries `refs{noTrans, datTrans, avantTax}` of the original, fixed at signing time, so an original still queued offline is referenced at once and the new record is queued behind it (no more 409, no fill-in at flush); original REJECTED → 400; a credit note cannot be credited; cancel = full credit note; correction = « Facture corrigée » (`relatedTransactionId` on a credited receipt) or the price-change flow; the flush never resets a CREDITED status |
| 10 class-validator DTOs | `transactions/dto`, `devices/dto`, `operators/dto`, `auth/dto` on the official fields (cents, `FP/F/P/NON`, `ARG/CRE/DEB/...`); global `ValidationPipe({ whitelist, transform })` in `src/bootstrap.ts` |
| SW-77 suite (d2d0dd6) | `backend/test/sw77/sw77-preparation.spec.ts`: same SW77-01…12 matrix on the official names, database + in-process API + simulator (`QCMEV_DB_TESTS=1 npm run test:integration`, run by `tools/local-run`). Honest label: internal, NOT Revenu Québec's personalized SW-77 |
| ThrottlerModule (d2d0dd6) | two tiers `short` / `medium` (`QCMEV_RATE_LIMIT_PER_SECOND` 10, `_PER_MINUTE` 100) per IP, per tenant on Food Hub routes (20/s), login 10/min, register 5/min; simulator + health skipped |

**No duplicate modules left:** one simulator (`src/simulator`), one receipt service (`src/receipts`), one key store
(`crypto/key-vault.ts`), one time helper (`common/time.ts`, America/Montreal), one offline mechanism, one `.env.example`
(`backend/.env.example`; the root one had placeholder secrets that the config now refuses).

**Checks (2026-10-24, Windows, Node 22, embedded PostgreSQL 16.14):** backend typecheck 0 errors, lint 0, Jest 94 unit tests
pass (+18 database tests skipped without a DB), `nest build` OK; frontend typecheck / lint / `next build` OK (10 pages);
`prisma migrate deploy` OK and `prisma migrate diff` = no drift; `tools/local-run/run-local.mjs` ALL GREEN: SW-77
preparation 18/18, `scripts/run-test-cases.ts` 13/13, Food Hub e2e 38/38 + 2/2 after restart, login rate limit 429.
Docker itself not run (no Docker on this machine).

**Notes:** a database created from either old init migration must be reset (`docker compose down -v`). The operator's
environment is fixed by the server's `MEV_ENVIRONMENT` (not by `Operator.environment` alone). The offline test uses the
simulator's `mevDown` switch instead of pointing the operator at an unreachable URL.

### ▶ NEXT SESSION — start here (replaces the list above)
1. Owner: review + merge the PR of `feature/official-protocol-foodhub` (it supersedes PR #2, which is closed).
2. Revenu Québec partner documents (SW-73, .A, .B, .D) → close `SPEC_GAPS.md` rows; personalized SW-77 cases → DEV, then ESSAI.
3. Product decision: keep `QCMEV_PUBLIC_REGISTRATION` open outside the simulator? Non-exportable key custody (KMS / HSM) before PROD.
4. Run `docker compose up --build` once on a machine with Docker.

---

## 2026-10-24 — Review round 1 on the protocol layer (branch `feature/official-protocol-foodhub`, PR #3)

Five findings of the round-1 review, each checked against Revenu Québec's public pages before fixing. All five were real.

| # | Finding | Fix | Source |
|---|---|---|---|
| 1 | Requests were sent as raw UTF-8 JSON (accents in item and user names) | `common/ascii-json.ts`: every character above 0x7E is sent as a JSON `\uXXXX` escape; SIGNATRANSM signs the exact ASCII bytes; the simulator refuses a non-ASCII body (`SIM-ASCII`). SPEC_GAPS #29 (escapes vs transliteration) | SW-76 2025-06 §4.2 « en utilisant la table ASCII » |
| 2 | CSR `L=` was today's daylight-saving offset (-04:00 from March to November) | `Operator.addressUtc` (new column, default `-05:00`; `-04:00` for Îles-de-la-Madeleine / Basse-Côte-Nord), register / settings DTOs, seed, dashboard setting; `crypto/csr.ts` refuses any other value; simulator checks it. Transaction `utc` unchanged, now SPEC_GAPS #30 | « Configuration du système d'enregistrement des ventes » |
| 3 | An expired certificate still issued invoices (warning + « CERTIFICAT INVALIDE ») | `TransactionsService.issue()` refuses: 423 `certReady` + CRITICAL audit, nothing signed or stored (sales, credit notes, reprints, Food Hub); the queue is held (nothing sent) until the renewal; the user report is displayed but not transmitted | « Obtention et suppression d'un ou plusieurs certificats numériques », Expiration |
| 4 | User report marked "built" without the listed contents; summary lacked 3 fields | `reports/user-report-renderer.ts`: business name, TPS / TVQ, user, address (numéro, rue, ville, code postal), last document of the device, device id, SEV id and version, login and production times, QR; summary never displayed. `sommVentes` gains `nbTransPai`, `ajus`, `mtdu` (names SPEC). `UserReport` keeps `deviceId`, `userId`, `summaryJson`, `displayJson`. Dashboard page rewritten. CERTIFICATION.md → partial; SPEC_GAPS #11, #31 | « Production du rapport de l'utilisateur », SW-76 §4.4.3 |
| 5 | A 4xx without `listErr` (gateway 401 / 403, wrong path 404, HTML page) counted as accepted (lost core-line rule) | `MevWebService.post()`: such a 4xx gets `{codRetour: "HTTP"}` → REJECTED, queue FAILED, audit (UTL: user not registered); 408 / 429 and a 2xx without the `retour*` envelope → unreachable (offline mode, sent again). SPEC_GAPS #32 | HANDOFF task 1 (core line) |

Migration: new `prisma/migrations/20261024150000_address_utc_user_report` (adds `Operator.addressUtc`, four nullable `UserReport` columns); the init migration is unchanged.

**Checks (2026-10-24, Windows, Node 22, embedded PostgreSQL 16):** backend typecheck 0 errors, lint 0, Jest 121 unit tests
pass (27 new in `test/protocol-round1.spec.ts`; 20 database tests skipped without a DB); frontend typecheck / lint / `next build`
OK (10 pages); `tools/local-run/run-local.mjs` ALL GREEN: build, `prisma migrate deploy`, migration drift = no difference,
SW-77 preparation 20/20 (new: ASCII, EXPIRED, CSR L=-05:00 in SW77-01, user report contents in SW77-11), seed, CRT + UTL,
`scripts/run-test-cases.ts` 13/13, Food Hub e2e 38/38 + 2/2 after restart, login rate limit 429.

**Food Hub:** no change needed (an expired certificate answers the existing 423 `location_not_ready` / `certReady`,
which Food Hub already treats as "not ready": slow retry + alert). CONTRACT.md says so.

### ▶ NEXT SESSION — start here (replaces the list above)
1. Owner: review + merge PR #3 (`feature/official-protocol-foodhub`).
2. Revenu Québec partner documents (SW-73, .A, .B, .D) → close `SPEC_GAPS.md` rows (#29 ASCII form, #30 `utc`, #31–32 new).
3. Product decision: keep `QCMEV_PUBLIC_REGISTRATION` open outside the simulator? Non-exportable key custody (KMS / HSM) before PROD.
4. Run `docker compose up --build` once on a machine with Docker.
