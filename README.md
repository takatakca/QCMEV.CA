# Takatak MEV (QCMEV)

Sales recording system (SEV, « système d'enregistrement des ventes ») for Québec restaurants, built to talk to Revenu
Québec's WEB-SRM (MEV-WEB) in mode SEV (it creates and signs its own transactions), and to receive the orders of TAKATAK Food Hub (Uber Eats, DoorDash,
SkipTheDishes, Too Good To Go, website, phone, storefront).

> **Status: NOT certified by Revenu Québec. Simulator / DEV (and ESSAI once Revenu Québec gives access) only.**
> Everything below works end to end against our **own local simulator**. Passing it proves nothing about conformity:
> only Revenu Québec's DEV and ESSAI environments, with the personalized SW-77 test cases, can. Production
> (`MEV_ENVIRONMENT=PROD`) refuses to start without a certification number. See [`SPEC_GAPS.md`](SPEC_GAPS.md) and
> [`CERTIFICATION.md`](CERTIFICATION.md).

This repository is public: it contains no secret, no certificate, no key, no authorization code and no identity number.
Tests use obvious placeholders (`XXXX-XXXX`, `ER0000`, `0000000000TQ0001`).

## What it does

* **CRT** — ECDSA P-256 key pair + CSR per device, certificate from WEB-SRM, private key stored AES-256-GCM encrypted,
  IDAPPRL saved. The decrypted key is never cached. **Renewal** (`CertificateLifecycleService`): CRT `REM` with the
  `noSerie` of the current certificate, signed with its key, so the device keeps its IDAPPRL and chain; on demand and
  every night at 03:00 America/Montreal for certificates within `CERT_RENEWAL_DAYS` (SPEC: renewal rules in SW-73).
* **Operators and users** — public first-time setup `POST /api/operators/register` (operator + first admin in one
  insert, 409 on a duplicate NEQ or username; `QCMEV_PUBLIC_REGISTRATION=false` closes it), or `npm run seed:operator`.
  Request bodies are validated by class-validator DTOs (400 with the list of problems, unknown fields stripped).
* **UTL** — users registered (`AJO`, `SUP`, `VAL`) on every certified device, again on a device after each new
  certificate; `POST /api/operators/users/sync-mev` catches up the users not registered yet; system user `FOODHUB-AUTO`.
* **TRX** — closing receipts and credit notes (`typTrans RFER`), additions / estimates / quotes (`ADDI`, `ESTM`, `SOUM`),
  reproductions (`RPR`) and merchant copies (`DUP`) — each transmitted, with:
  * numbering per device per civil day in America/Montreal, `datTrans` in local time plus `utc` (-04:00 / -05:00);
  * ECDSA signature of 88 characters, chained with `signa.preced` (88 « = » for the first), plus an internal SHA-256
    audit chain that is never transmitted;
  * money in integer cents, TPS 5 % and TVQ 9.975 % rounded half-up separately, `apresTax = avantTax + TPS + TVQ`
    exactly, tip (`pourb`) never inside `apresTax`;
  * WEB-SRM error classes: `codRetour` ending in 0, 1 or 5 → resent with the next batch; others → rejected (needs a human);
  * offline mode (SW-76 §4.7): a network failure never rejects a sale; it is signed locally, queued and sent as a
    `transLot` in chain order until the queue is empty; the MEV-WEB answer is written back to each transaction; the device
    goes back online only once its queue is empty (audit `OFFLINE_MODE_ACTIVATED` → `BATCH_SUBMITTED` →
    `OFFLINE_MODE_DEACTIVATED`); 48-hour watchdog (warning at 6 h, critical at 24 h and 48 h);
  * every stored transaction is checked at run time before it is sent (`mev-web/payload-validator.ts`): a malformed or
    tampered record is never sent (REJECTED, CRITICAL audit).
* **Changes after invoicing** always create real, referenced transactions (credit note and / or new receipt). A reference
  (`refs`: `noTrans`, `datTrans`, `avantTax`) is the original's own, fixed when it was signed: an original still in the
  offline queue can be credited (the credit note is queued behind it); an original REJECTED by MEV-WEB cannot be
  referenced (400). « Facture corrigée »: `POST /transactions` with the `relatedTransactionId` of a credited receipt.
* **DOC RUT** — the user report is displayed for the logged-in user with the contents Revenu Québec lists (business, user,
  address, last document of the device, device / SEV ids and version, login and production times, QR), and its sales
  summary (never displayed) is transmitted every time it is produced.
* **ASCII requests** — every MEV-WEB request is ASCII text (SW-76 §4.2): accents travel as JSON `\uXXXX` escapes.
* **Expired certificate** — no invoice (423 `certReady`) and nothing sent with it (TRX, DOC, UTL) until it is renewed;
  the queue waits. The renewal request (CRT `REM`) is the one request still signed with it (SPEC_GAPS #9).
* **Receipts** — exact 80 mm text (42 columns), HTML fragment, QR code (SVG + PNG), Revenu Québec's public mentions
  (« PAIEMENT REÇU », « NOTE DE CRÉDIT », « REPRODUCTION », « ***COPIE DU COMMERÇANT*** », « NE PAS REMETTRE AU CLIENT »,
  « ***DOCUMENT DE FORMATION*** », « COMMANDE PAR UNE PLATEFORME NUMÉRIQUE », « Copie électronique ») and `renderHash`.
* **Food Hub integration** — `/api/v1/integrations/foodhub`, HMAC-signed like Food Hub's `signContract`, idempotent
  (same key + same payload → replay; different payload → 409), replay guard, 422 field lists, 423 when a location is not
  ready. Contract: [`backend/src/integrations/foodhub/CONTRACT.md`](backend/src/integrations/foodhub/CONTRACT.md).
* **Local simulator** (SIMULATOR / DEV only) — checks headers, the ECDSA signatures of the request and of every
  transaction, the chain, amounts, duplicate numbers and the e-commerce payment rule; issues real X.509 certificates from a
  throwaway local CA; `mevDown` switch for offline tests. Its QR codes point to itself, never to a Revenu Québec domain.

Field names follow Revenu Québec's public documents. Exact JSON nesting, formats and the mandatory/optional matrix need
SW-73: every such place is marked `SPEC` (or `S1` for the 2022 sample code) in the code and listed in `SPEC_GAPS.md`.

## Layout

```
backend/                 NestJS 10 + Prisma 5 + PostgreSQL 16
  prisma/                schema.prisma + ONE init migration (migrations/20261024000000_init)
  src/config/            validated configuration (refuses weak / missing secrets, PROD without certification)
  src/crypto/            AES-256-GCM key vault, ECDSA P-256, CSR, QR encryption
  src/certificates/      CRT AJO / REM, certificate lifecycle + nightly renewal
  src/operators/         registration, settings, users, UTL (+ dto/)
  src/devices/           devices + certificate routes (+ dto/)
  src/mev-web/           WEB-SRM client, message types (official field names), runtime payload check
  src/transactions/      issuance, chain, credit notes, reprints, post-invoice changes
  src/receipts/          80 mm text / HTML / QR renderer
  src/offline/           batch flush + 48-hour watchdog
  src/integrations/foodhub/  Food Hub contract (CONTRACT.md), HMAC guard, idempotency
  src/simulator/         local WEB-SRM test double (never mounted in ESSAI / PROD)
  src/cli/seed-operator.ts   first operator, devices, users, location mappings from a file outside git
  test/                  Jest unit tests; test/sw77/ = SW-77 preparation suite (database, QCMEV_DB_TESTS=1)
frontend/                Next.js 14.2 dashboard (staff routes only)
scripts/run-test-cases.ts      12 internal scenarios (NOT SW-77)
scripts/verify-foodhub-e2e.ts  Food Hub → QCMEV end-to-end checks
tools/local-run/         Docker-free local run: embedded PostgreSQL + backend + simulator + all checks
```

## Run it locally without Docker (Windows, macOS, Linux; Node 20+)

```bash
cd backend && npm ci && cd ..
cd tools/local-run && npm install
node run-local.mjs            # add --keep to keep the temp folder, --skip-unit to skip Jest
```

It creates a temporary folder outside the repository with an embedded PostgreSQL 16 (UTF-8), random secrets and
placeholder identities, then: build → `prisma migrate deploy` → migration drift check (database = `schema.prisma`) →
SW-77 preparation suite (`npm run test:integration`: the whole API in-process + simulator, 18 checks) → `seed:operator` →
backend (SIMULATOR, Food Hub enabled) → CRT + UTL for two devices → Jest → `scripts/run-test-cases.ts` →
`scripts/verify-foodhub-e2e.ts` → backend restart → replay checks → login rate limit (11th attempt → 429) → teardown.
Last result (2026-10-24, Windows, Node 22): **ALL GREEN** — 18/18 SW-77 preparation checks, 94 unit tests, 13/13 internal
scenarios, 38/38 + 2/2 end-to-end checks (every signature verifies against the stored certificate, the chain and the
hash chain recompute, no identity value or secret in the logs). Our simulator only: this proves nothing about conformity.

## Run it with Docker (Coolify)

```bash
cp backend/.env.example .env    # fill it: openssl rand -hex 32 for each secret; never commit it
docker compose up -d --build    # backend runs prisma migrate deploy then node dist/main.js
# development (hot reload, SIMULATOR): docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
docker compose exec qcmev-backend sh -c 'SEED_FILE=/run/secrets/seed.json node dist/cli/seed-operator.js'
```

The backend port is not published: Food Hub reaches `http://qcmev-backend:3001` on the internal network. Only the
dashboard (port 3000) is public, and it forwards staff routes only.

## Configuration

All variables are documented in [`backend/.env.example`](backend/.env.example). Highlights:

| Variable | Rule |
|---|---|
| `JWT_SECRET`, `PRIVATE_KEY_ENCRYPTION_KEY` | required, random, 32 bytes; the server refuses to start otherwise |
| `MEV_ENVIRONMENT` | `SIMULATOR` (default) / `DEV` / `ESSAI` / `PROD`; it alone chooses the endpoint |
| `MEV_WEB_BASE_URL`, `MEV_QR_BASE_URL`, `MEV_IDSEV`, `MEV_IDVERSI`, `MEV_CODCERTIF`, `MEV_IDPARTN`, `MEV_VERSI`, `MEV_VERSIPARN` | required outside the simulator; given by Revenu Québec, typed by the owner |
| `QCMEV_CERTIFICATION_NUMBER` | without it, `PROD` is refused |
| `QCMEV_FOODHUB_ENABLED`, `QCMEV_FOODHUB_SECRET`, `QCMEV_FOODHUB_SECRET_PREVIOUS` | Food Hub integration, off by default |
| `CERT_RENEWAL_DAYS` (30), `SIMULATOR_CERT_VALIDITY_DAYS` (730) | nightly renewal window; simulator certificate validity |
| `QCMEV_PUBLIC_REGISTRATION` (true) | public `POST /operators/register` |
| `QCMEV_RATE_LIMIT_PER_SECOND` (10), `QCMEV_RATE_LIMIT_PER_MINUTE` (100) | global rate limit per IP (per tenant on the Food Hub routes) |

## API (prefix `/api`)

Staff routes use a JWT (`POST /api/auth/login`); every `:id` route is limited to the caller's operator, and roles are
checked (ADMIN, MANAGER, CASHIER).

| Route | Role | Purpose |
|---|---|---|
| `GET /health` | public | liveness (no data) |
| `POST /auth/login` | public | JWT (10 attempts / minute) |
| `POST /operators/register` | public | first-time setup: operator + first admin (5 / minute; can be turned off) |
| `GET /operators/me`, `GET /operators/mev-status` | staff | operator (no identity numbers), MEV status |
| `PUT /operators/me` | manager | whitelisted fields; environment change: admin + confirmation |
| `GET/POST /operators/users`, `POST /operators/users/:id/register` | admin | users, UTL `AJO` / `SUP` / `VAL` |
| `POST /operators/users/sync-mev` | manager | UTL `AJO` for every user not registered yet |
| `GET/PUT /operators/foodhub-locations`, `DELETE /operators/foodhub-locations/:id` | manager | Food Hub kitchen → SEV device (also creates and registers `FOODHUB-AUTO`); same as the « Cuisines Food Hub » card of the Appareils page |
| `GET /devices`, `POST /devices`, `GET /devices/:id`, `PUT /devices/:id`, `GET /devices/:id/offline-status`, `POST /devices/:id/flush-queue` | staff / manager | devices (file number and authorization code write-only, frozen once certified) and offline queue |
| `POST /devices/:id/certificate`, `POST /certificates/request` | manager | CRT (`AJO` first, `REM` after), then UTL for every user on that device |
| `GET /certificates`, `GET /certificates/active`, `GET /certificates/expiring`, `POST /certificates/renew`, `POST /certificates/:id/revoke` | manager | certificates, renewal now (CRT `REM`) |
| `GET/POST /transactions`, `GET /transactions/daily-summary`, `GET /transactions/:id`, `GET /transactions/:id/receipt`, `GET /transactions/:id/receipt/text` | staff | sales, corrected receipts, receipts (80 mm text for a thermal printer) |
| `POST /transactions/:id/credit-note`, `POST /transactions/:id/cancel` | manager | full or partial credit note |
| `POST /transactions/:id/reprint` (`RPR` / `DUP`) | staff | transmitted copies |
| `POST /transactions/:id/items`, `.../items/:itemId/remove`, `.../items/:itemId/price` | manager | post-invoice changes (new referenced transactions) |
| `GET /reports`, `POST /reports/user-report` | manager | DOC RUT |
| `/v1/integrations/foodhub/*` | HMAC | see CONTRACT.md |
| `/mev-simulator/*` | SIMULATOR / DEV only | local test double |

## Checks

```bash
cd backend  && npm ci && npx prisma generate && npm run typecheck && npm run lint && npm test && npm run build
cd frontend && npm ci && npm run typecheck && npm run lint && npm run build
cd tools/local-run && npm install && node run-local.mjs   # includes npm run test:integration on an embedded PostgreSQL
```

GitHub Actions (`.github/workflows/ci.yml`) runs the same, with no secret.

## For the Next Agent

**Two lines merged (branch `feature/official-protocol-foodhub`, replaces PR #2):** the core line (origin/main: offline
semantics, device identity fields, runtime payload validation, operator registration + DTOs, UTL sync, certificate
lifecycle + nightly renewal, JWT `sub`, tenant isolation, original references, rate limiting, SW-77 suite, Docker,
`HANDOFF.md`) now runs on the official layer below. Details and conflicts: `HANDOFF.md`.

**Done (official layer, from `fix/functional-mev`):** dependencies + lockfiles, first Prisma migration, build and startup fixed,
the missing routes, UTL wired, the Food Hub receiving endpoints (HMAC, idempotency, replay guard), Revenu Québec's public
field names and codes, ECDSA P-256 signatures and chain, offline queue with batch resend and 48-hour watchdog, receipt
renderer with the public mentions, DOC RUT, security fixes (no default secrets, AES-256-GCM keys, redacted logs,
roles and owner checks, rate limits, simulator never mounted in ESSAI / PROD), Jest unit tests, internal scenarios,
Food Hub end-to-end checks, a Docker-free local run, production Dockerfiles, Next.js 14.2.35, CI.

**Still needs Revenu Québec (cannot be done from code):**

1. Partner (product designer) registration and the developer identifiers → typed by the owner into the environment.
2. SW-73 / SW-73.A / SW-73.B / SW-73.D → close every row of `SPEC_GAPS.md` (URLs, nesting, formats, signed string, QR,
   receipt layout, CSR subject).
3. The personalized SW-77 test cases → import them, run in `DEV`, then `ESSAI` (`MEV_CASESSAI`), keep the logs.
4. Certification number, the production authorization code of the SEV, and a non-exportable key custody (SW-76 §4.2.1;
   KMS / HSM, not built) → only then `PROD`.

**Still to build (no Revenu Québec dependency):** Food Hub side of the contract (foodhubca branch
`feature/mev-qcmev-integration`, PR takatakca/foodhubca#99); certificate revocation (CRT `SUP` with `noSerie`);
a non-exportable key custody (KMS / HSM); `ANN` / `PSP` workflows; instalments; the dashboard pages for users and the RUT report
need polish; LICENSE (owner's choice).

**Owner decisions pending:** the license (no LICENSE file yet: until the owner adds one, no license is granted);
whether public operator self-registration stays open outside the simulator (`QCMEV_PUBLIC_REGISTRATION`).

## References (public)

* Revenu Québec — Facturation obligatoire, « Transmission des renseignements exigés » (modes de transaction, types de
  transactions, montants, taxes, modes de paiement, références, modes d'impression) and the list of certified SEVs for
  restaurants.
* SW-73, SW-73.A, SW-73.B, SW-73.D, SW-76, SW-77 — partner documents (not public; required for certification).
