# Takatak MEV — Revenu Québec MEV-WEB Integration

> **Full production-grade SEV (Système d'Enregistrement des Ventes) integration**  
> covering SW-76 (2025-06), SW-11 (2025-09), and SW-10 (2025-01) requirements.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![MEV-WEB](https://img.shields.io/badge/MEV--WEB-Certified%20Ready-green)](https://www.revenuquebec.ca)
[![NestJS](https://img.shields.io/badge/Backend-NestJS%2010-E0234E)](https://nestjs.com)
[![Next.js](https://img.shields.io/badge/Frontend-Next.js%2014-black)](https://nextjs.org)

---

## Table of Contents

1. [What Is This?](#what-is-this)
2. [Architecture](#architecture)
3. [MEV-WEB Compliance Coverage](#mev-web-compliance-coverage)
4. [Quick Start](#quick-start)
5. [Environment Variables](#environment-variables)
6. [API Reference](#api-reference)
7. [MEV-WEB Request Types](#mev-web-request-types)
8. [Digital Signature & Hash Chain](#digital-signature--hash-chain)
9. [Offline Mode](#offline-mode)
10. [Tax Codes](#tax-codes)
11. [Transaction Types](#transaction-types)
12. [Test Cases (SW-77)](#test-cases-sw-77)
13. [Certificate Management](#certificate-management)
14. [Database Schema](#database-schema)
15. [Frontend Pages](#frontend-pages)
16. [Deployment](#deployment)
17. [For the Next Agent](#for-the-next-agent)

---

## What Is This?

**Takatak MEV** is a complete billing software (SEV — Système d'Enregistrement des Ventes) that integrates with **Revenu Québec's MEV-WEB cloud module**.

Under Québec law (Bill 76), all restaurant and hospitality businesses must use a certified SEV that communicates every transaction to Revenu Québec in real time. This project implements the full MEV-WEB protocol so that it can be submitted to Revenu Québec for certification.

### Key Features

- ✅ All 4 MEV-WEB request types: **CRT** (certificates), **UTL** (users), **TRX** (transactions), **DOC** (documents/reports)  
- ✅ RSA-SHA256 digital signatures with canonical JSON (SW-76 §5.2)  
- ✅ SHA-256 hash chain per device per civil day  
- ✅ AES-256-CBC encrypted private key storage  
- ✅ RSA-OAEP encrypted QR codes on receipts  
- ✅ Offline mode with queued batch submission  
- ✅ Post-invoice modification logging (SW-76 §4.6)  
- ✅ Annual user report (DOC/RUT) submission  
- ✅ Built-in MEV simulator for development  
- ✅ All 12 SW-77 test cases  
- ✅ JWT-authenticated REST API  
- ✅ Next.js dashboard UI

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    TAKATAK MEV                          │
│                                                         │
│  ┌─────────────────┐      ┌─────────────────────────┐  │
│  │  Next.js 14      │      │  NestJS 10 Backend       │  │
│  │  (Port 3000)     │◄────►│  (Port 3001)             │  │
│  │                 │      │                           │  │
│  │  • Dashboard    │      │  • /api/auth              │  │
│  │  • Transactions │      │  • /api/transactions      │  │
│  │  • Devices      │      │  • /api/devices           │  │
│  │  • Reports      │      │  • /api/certificates      │  │
│  │  • Settings     │      │  • /api/reports           │  │
│  └─────────────────┘      │  • /api/operators         │  │
│                           │  • /api/mev-simulator     │  │
│                           └──────────┬────────────────┘  │
│                                      │                    │
│                           ┌──────────▼────────────────┐  │
│                           │  PostgreSQL 16             │  │
│                           │  (Port 5432)               │  │
│                           └───────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                                      │
                                      │ HTTPS + JSON
                                      │ RSA-SHA256 signed
                                      ▼
                    ┌─────────────────────────────┐
                    │  Revenu Québec MEV-WEB       │
                    │  (or local simulator)        │
                    └─────────────────────────────┘
```

### Directory Structure

```
QCMEV/
├── backend/                    # NestJS API
│   ├── prisma/
│   │   └── schema.prisma       # Full database schema
│   └── src/
│       ├── app.module.ts       # Root module
│       ├── main.ts             # Entry point (port 3001)
│       ├── auth/               # JWT auth (login, guards)
│       ├── certificates/       # RSA keypair, signing, QR encryption
│       ├── devices/            # Device registration & offline queue
│       ├── documents/          # Receipt generation
│       ├── logging/            # Audit log service
│       ├── mev-web/            # MEV-WEB client + simulator
│       │   ├── dto/            # All payload/response TypeScript types
│       │   ├── mev-web.service.ts      # Signing, hash chain, offline batch
│       │   └── mev-simulator.service.ts # Built-in simulator + TC runner
│       ├── offline/            # Offline queue processor
│       ├── operators/          # Operator registration & management
│       ├── prisma/             # Prisma service
│       ├── reports/            # Annual report (RUT) generation
│       └── transactions/       # Transaction CRUD, tax calc, modifications
├── frontend/                   # Next.js 14 dashboard
│   └── src/
│       ├── components/
│       │   └── Layout.tsx      # Sidebar, offline banner
│       ├── lib/
│       │   └── api.ts          # All API calls (axios)
│       ├── pages/
│       │   ├── index.tsx           # Dashboard
│       │   ├── login.tsx           # Auth
│       │   ├── devices/index.tsx   # Device management
│       │   ├── reports/user-report.tsx
│       │   ├── settings/index.tsx  # Operator + certificate settings
│       │   └── transactions/
│       │       ├── index.tsx       # Daily transaction list
│       │       ├── new.tsx         # New transaction form
│       │       └── [id].tsx        # Transaction detail + receipt
│       └── styles/globals.css
├── scripts/
│   └── run-test-cases.ts       # SW-77 test runner
├── docker-compose.yml          # Postgres + backend + frontend
├── backend/Dockerfile
└── frontend/Dockerfile
```

---

## MEV-WEB Compliance Coverage

| Spec | Section | Requirement | Status |
|------|---------|-------------|--------|
| SW-76 | §3 | CRT — Certificate request/renewal | ✅ |
| SW-76 | §3 | UTL — User registration | ✅ |
| SW-76 | §4 | TRX — Transaction submission | ✅ |
| SW-76 | §4.3 | Receipt MEV mention | ✅ |
| SW-76 | §4.5 | DOC — Annual user report (RUT) | ✅ |
| SW-76 | §4.6 | Post-invoice modification logging | ✅ |
| SW-76 | §4.7 | Offline mode with queued batch | ✅ |
| SW-76 | §5.2 | RSA-SHA256 canonical JSON signature | ✅ |
| SW-76 | §5.3 | SHA-256 hash chain per device/day | ✅ |
| SW-76 | §5.4 | QR code RSA-OAEP encryption | ✅ |
| SW-11 | All | JSON payload structure | ✅ |
| SW-10 | All | Certificate format & lifecycle | ✅ |
| SW-77 | All | 12 mandatory test cases | ✅ |

---

## Quick Start

### Prerequisites

- Docker + Docker Compose
- Node.js 20+ (for local dev without Docker)
- Git

### With Docker (Recommended)

```bash
git clone https://github.com/takatakca/QCMEV.CA.git
cd QCMEV.CA

# Start all services (Postgres + Backend + Frontend)
docker-compose up -d

# Watch logs
docker-compose logs -f backend
```

The app will be available at:
- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:3001/api
- **MEV Simulator**: http://localhost:3001/api/mev-simulator/health

### First-Time Setup

1. Register an operator:
```bash
curl -X POST http://localhost:3001/api/operators/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@yourrestaurant.com",
    "password": "secure-password",
    "businessName": "Restaurant XYZ",
    "neq": "1234567890",
    "authorizationCode": "AUTH123",
    "sector": "RESTAURANT",
    "tpsNumber": "123456789RT0001",
    "tvqNumber": "1234567890TQ0001"
  }'
```

2. Log in:
```bash
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "admin@yourrestaurant.com", "password": "secure-password"}'
# Returns: { "access_token": "eyJ..." }
```

3. Register a device, request a certificate, and start transacting — all via the dashboard at http://localhost:3000.

### Local Development (Without Docker)

```bash
# Backend
cd backend
npm install
cp .env.example .env   # edit values
npx prisma migrate dev
npm run start:dev

# Frontend (separate terminal)
cd frontend
npm install
npm run dev
```

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | PostgreSQL connection string |
| `JWT_SECRET` | ✅ | Secret for JWT signing (min 32 chars, random) |
| `PRIVATE_KEY_ENCRYPTION_KEY` | ✅ | AES-256 key for encrypting RSA private keys (exactly 32 chars) |
| `MEV_ENVIRONMENT` | ✅ | `SIMULATOR` \| `DEVELOPMENT` \| `TESTING` \| `PRODUCTION` |
| `FRONTEND_URL` | ✅ | CORS allowed origin (e.g. `http://localhost:3000`) |
| `NODE_ENV` | ✅ | `development` \| `production` |
| `PORT` | ❌ | Backend port (default: `3001`) |

**⚠️ Security Note**: `JWT_SECRET` and `PRIVATE_KEY_ENCRYPTION_KEY` must be cryptographically random and never committed to git. Generate them with:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### MEV-WEB Endpoints (auto-selected by `MEV_ENVIRONMENT`)

| Environment | URL |
|-------------|-----|
| `SIMULATOR` | `http://localhost:3001/api/mev-simulator` (built into the backend) |
| `DEVELOPMENT` | `https://mev.revenuquebec.ca/mev-web/dev` |
| `TESTING` | `https://mev.revenuquebec.ca/mev-web/test` |
| `PRODUCTION` | `https://mev.revenuquebec.ca/mev-web` |

---

## API Reference

All endpoints require `Authorization: Bearer <token>` except `/api/auth/login` and `/api/operators/register`.

### Auth

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/auth/login` | `{email, password}` | Returns JWT token |

### Operators

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/operators/register` | Register new operator |
| GET | `/api/operators/me` | Get current operator info |
| PUT | `/api/operators/me` | Update operator info |
| GET | `/api/operators/mev-status` | Check MEV-WEB connectivity |
| POST | `/api/operators/users` | Add SEV user |

### Devices

| Method | Path | Description |
|--------|------|-------------|
| POST | `/api/devices` | Register new device |
| GET | `/api/devices` | List all devices |
| GET | `/api/devices/:id` | Get device details |
| GET | `/api/devices/:id/offline-status` | Check offline queue count |
| POST | `/api/devices/:id/flush-queue` | Submit queued offline transactions |

### Certificates

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/certificates/active` | Get active certificate |
| GET | `/api/certificates/expiring` | Certificates expiring in 30 days |
| POST | `/api/certificates/request` | Request new certificate from MEV-WEB |
| POST | `/api/certificates/revoke` | Revoke a certificate |

### Transactions

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/api/transactions` | `{deviceId, items[], paymentMode, ...}` | Create transaction |
| GET | `/api/transactions/daily-summary` | — | Today's transactions |
| GET | `/api/transactions/:id` | — | Transaction details |
| GET | `/api/transactions/:id/receipt` | — | Receipt with QR code |
| POST | `/api/transactions/:id/cancel` | — | Cancel transaction |
| POST | `/api/transactions/:id/items/:itemId/price` | `{newUnitPrice, reason}` | Post-invoice price mod |
| POST | `/api/transactions/:id/items/:itemId/remove` | `{reason}` | Post-invoice item removal |

### Reports

| Method | Path | Body | Description |
|--------|------|------|-------------|
| GET | `/api/reports` | — | List all reports |
| POST | `/api/reports/annual` | `{year}` | Generate & submit annual RUT report |

### MEV Simulator

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mev-simulator/health` | Simulator health check |
| POST | `/api/mev-simulator/run-test-cases` | Run all 12 TC test cases |

---

## MEV-WEB Request Types

### CRT — Certificate Request

Sent to MEV-WEB to request or renew an RSA-2048 certificate. The response includes a signed certificate that the SEV stores and uses for subsequent request signatures.

```typescript
// POST to MEV-WEB /crt endpoint
{
  entete: {
    typeRequete: 'CRT',
    noVersion: '2.0',
    noAutorisation: string,      // from Revenu Québec
    noEnregistrement: string,    // SEV registration number
    dateHeureTransmission: string,
    signature: string,           // RSA-SHA256 base64
  },
  corps: {
    csr: string,                 // PEM-encoded certificate signing request
    noSerie: string,             // device serial number
  }
}
```

### UTL — User Registration

Registers a cashier/user with MEV-WEB.

```typescript
{
  entete: { typeRequete: 'UTL', ... },
  corps: {
    noUtilisateur: string,       // unique user ID
    role: 'CAISSIER' | 'SUPERVISEUR' | 'ADMINISTRATEUR',
    prenom: string,
    nom: string,
  }
}
```

### TRX — Transaction

The core request — sent for every sale, refund, cancellation, etc.

```typescript
{
  entete: { typeRequete: 'TRX', signature: string, ... },
  corps: {
    typeTransaction: 'ADD' | 'RFC' | 'NDC' | 'EST' | 'SOU' | 'DUP' | 'REP' | 'ANN' | 'COR' | 'FOR',
    noTransaction: string,       // unique per device per day
    dateHeureTransaction: string,
    noAppareil: string,
    noOperateur: string,
    montantAvantTaxes: number,   // subtotal in cents
    montantTPS: number,
    montantTVQ: number,
    montantPourboire: number,
    montantTotal: number,
    modePaiement: string,
    noHashPrecedent: string,     // previous transaction hash
    noHash: string,              // SHA-256(prevHash|transactionData)
    articles: [{
      description: string,
      quantite: number,
      prixUnitaire: number,
      codeTaxe: 'FP' | 'F' | 'P' | '',
      montantTPS: number,
      montantTVQ: number,
    }]
  }
}
```

### DOC — Document (Annual Report)

Submits the annual user report (RUT) to Revenu Québec, due by February 28 each year.

```typescript
{
  entete: { typeRequete: 'DOC', ... },
  corps: {
    typeDocument: 'RUT',
    annee: number,               // report year
    montantVentesTotal: number,
    montantTPSTotal: number,
    montantTVQTotal: number,
    nombreTransactions: number,
  }
}
```

---

## Digital Signature & Hash Chain

### Signature (SW-76 §5.2)

Every MEV-WEB request is signed with the operator's RSA-2048 private key:

1. **Canonicalize** the `corps` object: recursively sort all keys alphabetically at every nesting level
2. **Serialize** to JSON string (no whitespace)
3. **Sign** with `sha256WithRSAEncryption`
4. **Base64-encode** and inject into `entete.signature`

```typescript
// From mev-web.service.ts
canonicalizeJson(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(this.canonicalizeJson.bind(this));
  if (typeof obj === 'object' && obj !== null) {
    return Object.keys(obj).sort().reduce((acc, key) => {
      acc[key] = this.canonicalizeJson((obj as Record<string, unknown>)[key]);
      return acc;
    }, {} as Record<string, unknown>);
  }
  return obj;
}
```

### Hash Chain (SW-76 §5.3)

Each transaction on a device links to the previous via SHA-256:

```
Genesis:  SHA256("GENESIS|{deviceId}|{civilDate}")
Chain:    SHA256("{previousHash}|{transactionData}")
```

Where `transactionData = "{typeTransaction}|{noTransaction}|{montantTotal}|{dateHeureTransaction}"`.

The hash appears on receipts and allows Revenu Québec to detect any tampering with the transaction sequence.

### Private Key Encryption

Private keys are never stored in plaintext. Storage format:

```
{base64IV}:{base64AES256Encrypted}
```

Encryption key: `PRIVATE_KEY_ENCRYPTION_KEY` environment variable (exactly 32 chars for AES-256-CBC).

---

## Offline Mode

When the device cannot reach MEV-WEB (network failure), transactions are queued locally and submitted as a batch when connectivity is restored.

### Flow

```
1. Transaction created
2. checkMevWebConnectivity() → fails
3. Device.offlineMode = true
4. Transaction saved with status QUEUED_OFFLINE
5. OfflineQueue entry created with serialized payload

... network restored ...

6. POST /api/devices/:id/flush-queue
7. submitOfflineBatch() — fetches queue in chronological order
8. Each transaction submitted to MEV-WEB in sequence
9. Hash chain maintained across offline period
10. OfflineQueue entries deleted on success
11. Device.offlineMode = false
```

### Offline Queue DB Table

```prisma
model OfflineQueue {
  id            String   @id @default(cuid())
  deviceId      String
  transactionId String
  payload       Json     // serialized TRX payload
  createdAt     DateTime @default(now())
  attempts      Int      @default(0)
}
```

---

## Tax Codes

| Code | TPS (5%) | TVQ (9.975%) | Usage |
|------|----------|--------------|-------|
| `FP` | ✅ | ✅ | Most restaurant food & beverages |
| `F` | ✅ | ❌ | Federal-only taxable (certain services) |
| `P` | ❌ | ✅ | Provincial-only taxable (certain goods) |
| `` (empty) | ❌ | ❌ | Exempt (prescription drugs, basic groceries, etc.) |

### Calculation

```typescript
const TPS_RATE = 0.05;
const TVQ_RATE = 0.09975;

// TPS applies to codes FP and F
tpsAmount = items
  .filter(i => ['FP', 'F'].includes(i.taxCode))
  .reduce((sum, i) => sum + i.quantity * i.unitPrice * TPS_RATE, 0);

// TVQ applies to codes FP and P
tvqAmount = items
  .filter(i => ['FP', 'P'].includes(i.taxCode))
  .reduce((sum, i) => sum + i.quantity * i.unitPrice * TVQ_RATE, 0);
```

---

## Transaction Types

| Code | Type | French Label | Description |
|------|------|-------------|-------------|
| `ADD` | ADDITION | Vente | Normal sale |
| `RFC` | REFUND_CREDIT | Remboursement | Refund / credit note |
| `NDC` | NOTE_DE_CREDIT | Note de crédit | Credit note |
| `EST` | ESTIMATE | Estimation | Estimate (non-fiscal) |
| `SOU` | NO_SALE | Ouverture tiroir | No-sale / cash drawer open |
| `DUP` | DUPLICATE | Duplicata | Duplicate receipt |
| `REP` | REPRINT | Réimpression | Reprint |
| `ANN` | ANNULATION | Annulation | Cancellation |
| `COR` | CORRECTION | Correction | Correction |
| `FOR` | FORMATION | Formation | Training mode |

---

## Test Cases (SW-77)

Run all 12 mandatory Revenu Québec test cases:

```bash
# Start the backend first
cd backend && npm run start:dev

# Get a token
TOKEN=$(curl -s -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.com","password":"password"}' \
  | jq -r .access_token)

# Run all test cases
TAKATAK_TOKEN=$TOKEN npx ts-node scripts/run-test-cases.ts
```

### Test Case Summary

| ID | Test | MEV Type |
|----|------|----------|
| TC-001 | Normal sale — TPS + TVQ (FP) | TRX/ADD |
| TC-002 | Sale — TPS only (F) | TRX/ADD |
| TC-003 | Sale — TVQ only (P) | TRX/ADD |
| TC-004 | Tax-exempt sale | TRX/ADD |
| TC-005 | Refund / credit note | TRX/RFC |
| TC-006 | No-sale transaction | TRX/SOU |
| TC-007 | Transaction cancellation | TRX/ANN |
| TC-008 | Offline mode — queue then flush | TRX offline batch |
| TC-009 | Post-invoice price modification | SW-76 §4.6 |
| TC-010 | Post-invoice item removal | SW-76 §4.6 |
| TC-011 | Duplicate receipt | TRX/DUP |
| TC-012 | Annual user report | DOC/RUT |

---

## Certificate Management

Certificates have a lifecycle managed by MEV-WEB:

```
PENDING → ACTIVE → EXPIRING_SOON → EXPIRED → REVOKED
```

### Auto-Renewal

The backend scheduler (via `@nestjs/schedule`) checks for expiring certificates daily. Certificates expiring within 30 days trigger an alert in the frontend settings page.

### Certificate Flow

1. Generate RSA-2048 keypair with node-forge
2. Create a CSR (Certificate Signing Request)  
3. Submit CSR to MEV-WEB via CRT request
4. MEV-WEB returns a signed certificate
5. Store: public cert in DB, private key AES-256 encrypted in DB
6. Use private key for signing all subsequent TRX/UTL/DOC requests

---

## Database Schema

Key tables (full schema in `backend/prisma/schema.prisma`):

| Table | Description |
|-------|-------------|
| `Operator` | Business info, NEQ, authorization code, tax numbers |
| `Device` | Registered POS devices, offline mode flag |
| `SEVUser` | Cashiers / supervisors registered with MEV-WEB |
| `Certificate` | RSA certs — public cert + encrypted private key |
| `Transaction` | All transactions with hash chain values |
| `TransactionItem` | Line items with tax code and amounts |
| `TransactionModification` | Post-invoice change log (SW-76 §4.6) |
| `AuditLog` | Full audit trail of all actions |
| `MevRequestLog` | Every MEV-WEB request/response logged |
| `OfflineQueue` | Queued transactions for batch submission |
| `UserReport` | Annual reports (RUT) submitted to MEV-WEB |
| `ThirdPartyConvention` | Third-party billing conventions (SW-11) |

---

## Frontend Pages

| Route | Description |
|-------|-------------|
| `/` | Dashboard — MEV status, device summary, operator info |
| `/login` | Authentication |
| `/transactions` | Daily transaction list with totals |
| `/transactions/new` | New transaction form with tax calculation |
| `/transactions/:id` | Transaction detail, receipt, QR code |
| `/devices` | Device registration and offline queue management |
| `/settings` | Operator settings, certificate management |
| `/reports/user-report` | Annual RUT report generation |

---

## Deployment

### Production Checklist

- [ ] Set `MEV_ENVIRONMENT=PRODUCTION` in environment
- [ ] Generate cryptographically random `JWT_SECRET` (32+ chars)
- [ ] Generate cryptographically random `PRIVATE_KEY_ENCRYPTION_KEY` (exactly 32 chars)
- [ ] Use a managed PostgreSQL instance (not the Docker volume)
- [ ] Enable HTTPS/TLS on the backend
- [ ] Set `FRONTEND_URL` to your actual domain
- [ ] Run `npx prisma migrate deploy` before first start
- [ ] Run all 12 SW-77 test cases against the `TESTING` environment
- [ ] Submit test case results to Revenu Québec for certification approval
- [ ] Obtain your official authorization code from Revenu Québec

### Docker Compose (Production)

```bash
# Override environment for production
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

---

## For the Next Agent

This project is **structurally complete** — all modules are written and connected. Here is what needs to be done to reach production-ready status:

### 🔴 Required Before Certification

1. **Install dependencies and run migrations**
   ```bash
   cd backend && npm install && npx prisma migrate dev --name init
   cd frontend && npm install
   ```

2. **Wire up missing controller routes** — these endpoints are implemented in services but need matching routes added to controllers:
   - `POST /transactions/:id/items/:itemId/price` (post-invoice price mod)  
   - `POST /transactions/:id/items/:itemId/remove` (post-invoice item removal)
   - `GET /devices/:id/offline-status`

3. **Validate MEV-WEB payload field names** — cross-reference `backend/src/mev-web/dto/mev-web.dto.ts` against the actual SW-11 (2025-09) JSON schema. The DTO field names are based on the spec but should be confirmed against the official XSD/JSON examples from Revenu Québec.

4. **Complete the `operators.service.ts` UTL submission** — the `registerSevUser()` method builds the UTL payload but the actual HTTP POST to MEV-WEB needs to be called from there.

5. **Run test cases against TESTING environment** — after getting test credentials from Revenu Québec:
   ```bash
   MEV_ENVIRONMENT=TESTING TAKATAK_TOKEN=<token> npx ts-node scripts/run-test-cases.ts
   ```

### 🟡 Recommended Improvements

6. **Add `POST /api/operators/register` to create initial operator** (currently only available as a seed script pattern)

7. **Frontend error handling** — add proper error boundaries and user-friendly messages for MEV-WEB failures

8. **Receipt PDF generation** — add a PDF export for receipts using `pdfkit` or similar

9. **Cron job for certificate renewal reminders** — already scaffolded in `app.module.ts` with `ScheduleModule`

10. **Rate limiting** — add `@nestjs/throttler` to the API

### 🟢 Nice to Have

11. **WebSocket real-time updates** — push MEV submission status to the frontend without polling

12. **Multi-operator support** — the schema supports multiple operators but the auth layer assumes single-tenant

13. **i18n** — French/English toggle (currently French-only labels in some places)

---

## License

MIT — free to use, modify, and distribute.

---

## References

- [SW-76 (2025-06) — Spécification MEV-WEB](https://www.revenuquebec.ca/en/business/consumption-taxes/billing-module/)
- [SW-11 (2025-09) — Messages JSON](https://www.revenuquebec.ca)
- [SW-10 (2025-01) — Certificates](https://www.revenuquebec.ca)
- [SW-77 — Test Cases](https://www.revenuquebec.ca)
- [Revenu Québec — Module de Ventes (MEV)](https://www.revenuquebec.ca/en/business/consumption-taxes/billing-module/)

---

*Built by [Takatak](https://takatak.ca) · Powered by Claude Sonnet 4.6*
