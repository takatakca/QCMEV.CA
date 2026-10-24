# Takatak MEV (QCMEV)

Sales recording system (SEV, « système d'enregistrement des ventes ») for Québec restaurants, built to talk to Revenu
Québec's WEB-SRM (MEV-WEB) in remote-server mode, and to receive the orders of TAKATAK Food Hub (Uber Eats, DoorDash,
SkipTheDishes, Too Good To Go, website, phone, storefront).

> **Status: NOT certified by Revenu Québec. Simulator / DEV only.**
> Everything below works end to end against our **own local simulator**. Passing it proves nothing about conformity:
> only Revenu Québec's DEV and ESSAI environments, with the personalized SW-77 test cases, can. Production
> (`MEV_ENVIRONMENT=PROD`) refuses to start without a certification number. See [`SPEC_GAPS.md`](SPEC_GAPS.md) and
> [`CERTIFICATION.md`](CERTIFICATION.md).

This repository is public: it contains no secret, no certificate, no key, no authorization code and no identity number.
Tests use obvious placeholders (`XXXX-XXXX`, `ER0000`, `0000000000TQ0001`).

## What it does

* **CRT** — ECDSA P-256 key pair + CSR per device, certificate from WEB-SRM, private key stored AES-256-GCM encrypted,
  IDAPPRL saved. The decrypted key is never cached.
* **UTL** — users registered (`AJO`, `SUP`, `VAL`) on every certified device; system user `FOODHUB-AUTO`.
* **TRX** — closing receipts and credit notes (`typTrans RFER`), additions / estimates / quotes (`ADDI`, `ESTM`, `SOUM`),
  reproductions (`RPR`) and merchant copies (`DUP`) — each transmitted, with:
  * numbering per device per civil day in America/Montreal, `datTrans` in local time plus `utc` (-04:00 / -05:00);
  * ECDSA signature of 88 characters, chained with `signa.preced` (88 « = » for the first), plus an internal SHA-256
    audit chain that is never transmitted;
  * money in integer cents, TPS 5 % and TVQ 9.975 % rounded half-up separately, `apresTax = avantTax + TPS + TVQ`
    exactly, tip (`pourb`) never inside `apresTax`;
  * WEB-SRM error classes: `codRetour` ending in 0, 1 or 5 → resent with the next batch; others → rejected (needs a human);
  * offline mode: a network failure never rejects a sale; it is signed locally, queued and sent as a `transLot`;
    48-hour watchdog (warning at 6 h, critical at 24 h and 48 h).
* **Changes after invoicing** always create real, referenced transactions (credit note and / or new receipt).
* **DOC RUT** — the user report is transmitted every time it is displayed.
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
  prisma/                schema.prisma + migrations/0001_init
  src/config/            validated configuration (refuses weak / missing secrets, PROD without certification)
  src/crypto/            AES-256-GCM key vault, ECDSA P-256, CSR
  src/mev-web/           WEB-SRM client + message types (official field names)
  src/transactions/      issuance, chain, credit notes, reprints, post-invoice changes
  src/receipts/          80 mm text / HTML / QR renderer
  src/offline/           batch flush + 48-hour watchdog
  src/integrations/foodhub/  Food Hub contract (CONTRACT.md), HMAC guard, idempotency
  src/simulator/         local WEB-SRM test double (never mounted in ESSAI / PROD)
  src/cli/seed-operator.ts   first operator, devices, users, location mappings from a file outside git
  test/                  Jest unit tests
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
placeholder identities, then: build → `prisma migrate deploy` → `seed:operator` → backend (SIMULATOR, Food Hub enabled) →
CRT + UTL for two devices → Jest → `scripts/run-test-cases.ts` → `scripts/verify-foodhub-e2e.ts` → backend restart →
replay checks → teardown. Last result: **ALL GREEN** — 13/13 internal scenarios, 35/35 + 2/2 end-to-end checks
(every signature verifies against the stored certificate, the chain and the hash chain recompute, no identity value or
secret in the logs).

## Run it with Docker (Coolify)

```bash
cp backend/.env.example .env    # fill it: openssl rand -hex 32 for each secret; never commit it
docker compose up -d --build    # backend runs prisma migrate deploy then node dist/main.js
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

## API (prefix `/api`)

Staff routes use a JWT (`POST /api/auth/login`); every `:id` route is limited to the caller's operator, and roles are
checked (ADMIN, MANAGER, CASHIER).

| Route | Role | Purpose |
|---|---|---|
| `GET /health` | public | liveness (no data) |
| `POST /auth/login` | public | JWT (10 attempts / minute) |
| `GET /operators/me`, `GET /operators/mev-status` | staff | operator (no identity numbers), MEV status |
| `PUT /operators/me` | manager | whitelisted fields; environment change: admin + confirmation |
| `GET/POST /operators/users`, `POST /operators/users/:id/register` | admin | users, UTL `AJO` / `SUP` / `VAL` |
| `GET /devices`, `GET /devices/:id`, `PUT /devices/:id`, `GET /devices/:id/offline-status`, `POST /devices/:id/flush-queue` | staff / manager | devices and offline queue |
| `POST /devices/:id/certificate` | manager | CRT, then UTL for every user on that device |
| `GET /certificates`, `GET /certificates/expiring`, `POST /certificates/:id/revoke` | manager | certificates |
| `GET/POST /transactions`, `GET /transactions/daily-summary`, `GET /transactions/:id`, `GET /transactions/:id/receipt` | staff | sales and receipts |
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
cd tools/local-run && npm install && node run-local.mjs
```

GitHub Actions (`.github/workflows/ci.yml`) runs the same, with no secret.

## For the Next Agent

**Done (branch `fix/functional-mev`):** dependencies + lockfiles, first Prisma migration, build and startup fixed,
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
4. Certification number and the production remote-server authorization code (FO-350.SD) → only then `PROD`.

**Still to build (no Revenu Québec dependency):** Food Hub side of the contract (foodhubca branch
`feature/mev-qcmev`: outbox, hooks, ticket printing, `/r/{token}`); certificate renewal / revocation with `noSerie`;
« Facture corrigée » mention; `ANN` / `PSP` workflows; instalments; the dashboard pages for users and the RUT report
need polish; LICENSE (owner's choice).

**Owner decisions pending:** the license (no LICENSE file yet: until the owner adds one, no license is granted).

## References (public)

* Revenu Québec — Facturation obligatoire, « Transmission des renseignements exigés » (modes de transaction, types de
  transactions, montants, taxes, modes de paiement, références, modes d'impression) and the list of certified SEVs for
  restaurants.
* SW-73, SW-73.A, SW-73.B, SW-73.D, SW-76, SW-77 — partner documents (not public; required for certification).
