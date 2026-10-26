# HANDOFF — QCMEV.CA work log

> **Priorité du 26 octobre 2026 : backend et intégrations. Lire READINESS.md et la dernière entrée ci-dessous avant de reprendre une ancienne liste.**

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


## 2026-10-24 — Dossier administratif Revenu Québec (priorité utilisateur)

**Avant de refaire les PDF ou de reprendre le code : lire [docs/revenu-quebec/REPRISE.md](docs/revenu-quebec/REPRISE.md).**

L’utilisateur demande désormais toutes les notes dans GitHub et autorise la poursuite de l’envoi à Revenu Québec. Deux originaux lus; SW-10 corrigé (copie avec signature manuscrite du concepteur conservée + copie pour nouvelle signature), résolution préparée et brouillon `.eml` produit. Aucun courriel envoyé : aucun outil/compte de messagerie disponible; résolution non signée; aucun certificat de signature numérique fourni. Le journal détaillé distingue les résultats vérifiés des affirmations de l’ancien agent et donne les étapes restantes. Le commit annoncé `fbcc91f` n’a pas été retrouvé dans les branches distantes accessibles.

La branche distante `feature/official-protocol-foodhub` (`903e9db`) contient des travaux techniques plus récents que ce main, dont CERTIFICATION.md et SPEC_GAPS.md. Ne pas reprendre aveuglément l’ancienne liste technique de ce HANDOFF sans lire son état de relève sur cette branche. Aucune fusion de code ni validation officielle effectuée dans cette session.


### Suivi administratif — compte et classement

Dernière demande : **takatak.ca@gmail.com** comme expéditeur, suivi des réponses et archivage dans le OneDrive associé. `docs/revenu-quebec/ENVOI-ET-SUIVI.md` décrit le dossier prêt à envoyer et les règles de classement / reprise. Lettre texte + PDF et `.eml` mis à jour. Aucun outil Gmail ou OneDrive exposé : aucun envoi, dépôt ou surveillance automatique actif. Ne pas demander de nouveau les coordonnées ni refaire les documents existants.


### Résolution électronique — dernière étape documentaire

Résolution PDF avec trois champs de signature et trois dates créée, ainsi qu’un dossier combiné de 7 pages avant signature. Lire `docs/revenu-quebec/VERIFICATION-CHAMPS.md` pour l’inventaire des champs vérifiés et ceux laissés vides. Champs administratifs du SW-10 remplis avec les renseignements fournis; numéro d’identification et poste non fournis laissés vides, signature/date Revenu Québec réservées. Résolution toujours non signée, non adoptée; aucun envoi.
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

---

## 2026-10-24 — Review round 2 on the protocol layer (branch `feature/official-protocol-foodhub`, PR #3)

One finding (major, integrity), real. The round-1 fix decided "does this 4xx carry its errors?" on any `listErr`
found anywhere in the body (depth 5), while the callers read only the `retour*` envelope (and, for TRX, its items).
A 4xx with a `listErr` outside the envelope (top-level `{listErr}`, `{erreur: {listErr}}`) therefore reached the
caller with an empty list and was **accepted**: sale ACCEPTED with no MEV-WEB number, queue COMPLETED, no audit,
never sent again; UTL user marked registered; DOC report ACCEPTED. Same family: in a 4xx batch answer, a transaction
left without an error of its own (another one carrying real errors) was accepted too.

| Fix | Where |
|---|---|
| `readableErrors(kind, answer)`: the envelope's own `listErr`, plus each `retourTransActu` / `retourTransLot` item's `listErr` for TRX: exactly what `sendTransactions`, `OperatorsService`, `CertificatesService`, `ReportsService` read. A 4xx with nothing there gets `{codRetour: "HTTP"}` in the envelope; the depth-5 walk (`firstErrorCode`) is gone. `MevRequestLog.mevErrorCode` / `success` follow the same lists | `backend/src/mev-web/mev-web.service.ts` |
| In a 4xx batch answer every transaction left without an error gets `HTTP-<status>` (REJECTED); real errors keep their class (95 stays `retry_batch`). 2xx answers unchanged | `MevWebService.sendTransactions` |
| Tests: 15 new in `backend/test/protocol-round2.spec.ts`, including end to end through the real `TransactionsService.submitBatch` (REJECTED, queue FAILED, MEV_ERROR audit) and `OperatorsService.registerSevUser` (user not registered) | `backend/test/protocol-round2.spec.ts` |

SPEC_GAPS #32 updated (where MEV-WEB puts header-level errors is unknown; SW-73).

**Checks (2026-10-24, Windows, Node 22, embedded PostgreSQL 16):** backend typecheck 0 errors, lint 0, Jest 136 unit
tests pass (20 database tests skipped without a DB); `tools/local-run/run-local.mjs --skip-unit` ALL GREEN: build,
`prisma migrate deploy`, migration drift = no difference, SW-77 preparation 20/20, seed, CRT + UTL,
`scripts/run-test-cases.ts` 13/13, Food Hub e2e 38/38 + 2/2 after restart, login rate limit 429. No migration.

**Food Hub:** no change needed (a REJECTED sale is already reported to Food Hub as rejected; CONTRACT.md unchanged).

### ▶ NEXT SESSION — start here (replaces the list above)
1. Owner: review + merge PR #3 (`feature/official-protocol-foodhub`).
2. Revenu Québec partner documents (SW-73, .A, .B, .D) → close `SPEC_GAPS.md` rows (#29 ASCII form, #30 `utc`, #31–32).
3. Product decision: keep `QCMEV_PUBLIC_REGISTRATION` open outside the simulator? Non-exportable key custody (KMS / HSM) before PROD.
4. Run `docker compose up --build` once on a machine with Docker.

---

## 2026-10-24 — Review minors on PR #3 (branch `feature/official-protocol-foodhub`)

Five minor findings from the end-to-end and protocol reviews, plus one doc alignment. All fixed with tests.

| # | Finding | Fix | Where |
|---|---|---|---|
| 1 | The « Réf. » line of every credit note / corrected receipt was cut at exactly 42 characters, in the middle of the time | `wrap()` / `wrapTokens()` break only between words; « Réf. : transaction N » / « du AAAA-MM-JJ hh:mm:ss » (date and time kept whole). Checked for every line type: name, address, city, date, number, order, item (description wraps under itself, amount stays on the first line; it used to be truncated), TPS / TVQ numbers, payment, « Crédité à » (was truncated), mentions, MEV-WEB time and number, device id. Only a single word longer than 42 is ever cut | `receipts/receipt-renderer.ts`, `test/receipt-layout.spec.ts` (14 layouts) |
| 2 | Dashboard « Environnement » tile always « – » (read `mevStatus.operator.mevEnvironment`, which does not exist); the « Exploitant » card never showed and would have shown the authorization code | Tile reads `environment` (+ « Non certifié : simulateur / essais seulement »); the card reads `GET /operators/me` (no NEQ, no authorization code). `test/dashboard-contract.spec.ts` fails if a page reads a field the API does not send | `frontend/src/pages/index.tsx` |
| 3 | No API route or screen to link a Food Hub location to a device (only the seed CLI) | `GET/PUT /api/operators/foodhub-locations`, `DELETE /api/operators/foodhub-locations/:id` (manager; row kept inactive); linking creates `FOODHUB-AUTO` and registers it with UTL when a device is certified; another operator's location → 409, another operator's device → 404. Dashboard: « Appareils » → « Cuisines Food Hub » | `integrations/foodhub/foodhub-locations.ts`, `frontend/src/components/FoodHubLocations.tsx`; tests `test/review-minors.spec.ts`, SW-77 suite `FH-LOCATION`, e2e L2 / L3 |
| 4 | Food Hub's test stand-in (`scripts/e2e/mock-qcmev.mjs`, verify:foodhub section 48) numbers `261024-0001` and puts « RÉF. FACTURE N » in the credit-note mentions; the real QCMEV sends `"1"`, `"2"`… and a « Réf. » text line | QCMEV side: CONTRACT.md §7 « What Food Hub may rely on » (opaque `noTrans`, `mevTransactionNumber` as received, the reference is a text line, credit notes and copies dated when issued in Montréal time, 42 columns). **Food Hub side still to do** (not this branch): align the stand-in and the two checks (S1 regex, S6 mention) in Food Hub PR #99 | `integrations/foodhub/CONTRACT.md` |
| 5 | UTL was still sent with an expired certificate, while CERTIFICATION.md / SPEC_GAPS #9 said "every transmission" was blocked | `registerSevUser()` skips a device whose certificate has expired (CRITICAL audit); that device registers every active user right after its renewal; all devices expired → 423 `certReady`, user not registered. Docs now say exactly what is still sent: only the renewal CRT `REM` | `operators/operators.ts`; tests `test/review-minors.spec.ts`, SW-77 `EXPIRED` |
| 6 | CONTRACT.md §8 said Food Hub alerts at 15 minutes | Aligned with Food Hub `docs/MEV_INTEGRATION.md` §6: CRITICAL after 1 minute for a sale or credit note waiting (at once when held for a person or waiting for its payment mode); copies: warning at 15 minutes | `integrations/foodhub/CONTRACT.md` |

No migration, no new environment variable. The renderer change alters `text80mm` (and so `renderHash`) of receipts with
long lines; nothing stores `renderHash`.

**Checks (2026-10-24, Windows, Node 22, embedded PostgreSQL 16):** backend typecheck 0 errors, lint 0, Jest 164 passed
(21 database tests skipped without a DB), build OK; frontend typecheck, lint (no warning) and `next build` (10 pages) OK;
`tools/local-run/run-local.mjs` ALL GREEN in 155 s: build, `prisma migrate deploy`, drift = none, SW-77 preparation 21/21
(new FH-LOCATION; EXPIRED now also checks UTL), seed, CRT + UTL, Jest 164, `scripts/run-test-cases.ts` 13/13, Food Hub
e2e 40/40 (new L2, L3) + 2/2 after restart, login rate limit 429.

### ▶ NEXT SESSION — start here (replaces the list above)
1. Owner: review + merge PR #3 (`feature/official-protocol-foodhub`).
2. Food Hub PR #99: align `scripts/e2e/mock-qcmev.mjs` with CONTRACT.md §7 (numbers `"1"`, `"2"`…; the reference as a
   « Réf. » text line, not a mention; `mevTransactionNumber` opaque; copies dated in Montréal time) and the S1 / S6
   checks of `scripts/e2e/mev-scenarios.mjs`.
3. Revenu Québec partner documents (SW-73, .A, .B, .D) → close `SPEC_GAPS.md` rows (#9 REM with an expired certificate, #29 ASCII form, #30 `utc`, #31–32).
4. Product decision: keep `QCMEV_PUBLIC_REGISTRATION` open outside the simulator? Non-exportable key custody (KMS / HSM) before PROD.
5. Run `docker compose up --build` once on a machine with Docker.


## 2026-10-26 — Reprise backend et intégrations (fix/backend-readiness)

Objectif utilisateur : continuer le logiciel jusqu’à une livraison vérifiée et lister tous les manques, sans annoncer une production fictive. Intégration de `feature/official-protocol-foodhub` (`903e9db`) avec les PDF et notes main, sans effacer les historiques. Corrections : rejeu concurrent Food Hub, remboursements concurrents/soldes de taxes atomiques, accusés MEV incomplets, numéros identiques sur deux journées hors ligne, file bornée, readiness DB, validation des paramètres, dépendances de production corrigées, routage interne Next au build, permissions et contexte Docker, calcul de l’aperçu des ventes, précontrôle empêchant une migration silencieuse de l’ancien init.

Lire **READINESS.md** pour la preuve des tests et l’inventaire des neuf blocages de production. La branche n’est pas un déploiement et le simulateur n’est pas une certification officielle. Secrets de test et bases temporaires supprimés à la fin du runner. `scripts/verify-frontend-container.py` reproduit le contrôle conteneur/proxy et la CI comprend les jobs d’image; leur résultat distant doit être constaté séparément.

Ne pas refaire les documents administratifs. Ne pas réinitialiser une base existante. Aucune signature, aucun courriel ou dépôt OneDrive ni appel réel de plateforme effectué. La question sur les données de production existantes est en attente; préserver les données par défaut. Aucun travail ne continue en arrière-plan après la fin de cette tâche.


### Résultats et installation distante

Parcours complet du 26 octobre : 203 tests unitaires + 24 tests DB exécutés séparément, 40+2 contrôles Food Hub, précontrôle/migrations/dérive, CRT/UTL, redémarrage et limitation : tout passe localement. Frontend Docker construit et démarré, transport HTTP du proxy vérifié. Audits de production 0/0. Première CI sur `5bf6567` : échec npm ci backend sur Node 22/npm 10 (entrée Webpack imbriquée manquante), malgré réussite npm 11 locale. Reproduit dans Node 22, lockfile corrigé par npm 10.9.9, dry-run gelé réussi; nouvelle CI nécessaire. Image backend toujours à confirmer hors du blocage HTTP 403 Alpine local.
