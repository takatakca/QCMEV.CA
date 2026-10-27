# HANDOFF — Revenu Québec (QCMEV) + Clover + Food Hub — 2026-10-27

Read this first. Any agent or person can continue from here. Nothing below is merged into `main` (the owner merges).

## The goal (owner's words)
Complete everything Revenu Québec needs (they will ask for a demonstration video), put the solution on Clover so it can
be sold on the Clover App Market, and give the Food Hub restaurants the same integration.

## Architecture (decided after reading all branches — do not rebuild)
- **QCMEV.CA** = the SEV (Takatak MEV): numbers, signs and sends every sale to MEV-WEB, prints the invoice layout.
  Current code line = branch `fix/backend-readiness` (official protocol, 203+ tests, green CI). My branch
  `claude/nice-cray-4fhekg` = that line + my commits below.
- **foodhubca** = the Clover backend (OAuth, webhooks, several Clover apps in one registry) and the order hub. It sends
  sales to QCMEV through the HMAC contract `backend/src/integrations/foodhub/CONTRACT.md`.
- **Clover register sales** go: Clover order paid → Food Hub (webhook + catch-up poll) → QCMEV → invoice → the TAKATAK
  MEV Android app on the Clover device prints it with its QR code (Clover's REST API cannot print a QR).

## DONE (pushed, with tests)

### QCMEV.CA — branch `claude/nice-cray-4fhekg`
| Commit | What |
|---|---|
| `1dc2849` | Tenant isolation on transaction routes, queued-original cancellations, request DTOs (already merged into fix/backend-readiness) |
| `c9e97ae` + merge `28ce1ea` | My partner-API attempt **reverted** (fix/backend-readiness already covered it); branch brought up to fix/backend-readiness |
| `9656470` | **Demo video** `docs/revenu-quebec/demo/takatak-mev-demonstration.mp4` (3 min, French captions, 19 scenes) + recorder `tools/demo-video/` + sale form options (document kind, service, print medium, training) |
| `d179f96` | Contract accepts `source.model: "pos"` + channel `clover_pos` (Clover register sales) |
Checks: 205 unit tests, full local run green (25 PostgreSQL tests, 13 scenarios, Food Hub contract 40/40 + 2/2).

**The video is a REHEARSAL on QCMEV's local simulator with fake data — not Revenu Québec's DEV/ESSAI and not the
official demonstration.** Re-record with ESSAI + Revenu Québec's personalized SW-77 cases: `docs/revenu-quebec/demo/README.md`.

### foodhubca — branch `feature/mev-qcmev-integration` (PR #99)
- `2720832` QCMEV stand-in + checks aligned with QCMEV CONTRACT.md §7 (the gap READINESS.md item 8 listed). 1702 tests, e2e 617/0.

### foodhubca — branch `feature/mev-clover-register` (stacked on PR #99, no PR opened yet)
| Commit | What |
|---|---|
| `73df1e4` | Clover register sales → Takatak MEV invoices (`lib/foodhub/mev/clover-register.ts`, `map.ts toMevSaleFromRegister`, hooks/outbox model `pos`). Off unless `FOODHUB_MEV_CLOVER_REGISTER=on`. Paid → sale, refund/void/delete → credit note, items refunded → credit note + corrected receipt, wrong Clover tax rate → held for a person. Docs: `docs/MEV_INTEGRATION.md` § 10 |
| `72b9c18` | **TAKATAK MEV = third Clover app** in the registry (`CLOVER_MEV_APP_ID/_SECRET/_WEBHOOK_AUTH`, OAuth start/callback, webhook `/api/foodhub/webhooks/clover/mev`), **device endpoint** `/api/foodhub/mev/clover-device/receipt|print|copy` (merchant's Clover token checked with Clover). Docs: `docs/CLOVER_MULTI_APP.md` § TAKATAK MEV |
| `8eec7e5` (WIP) | **Android app** `apps/clover-mev-android` (Kotlin; Clover SDK 341 API names verified from the real library). README there |
Checks (before the Android commit): typecheck, lint 0 errors, 1721 tests, `next build --webpack`, `verify:foodhub` 617/0.

## NOT DONE — exact next steps, in order
1. ~~Android build~~ **DONE**: `./gradlew test assembleDebug` OK (Clover SDK 341), 8/8 unit tests, debug APK 4.4 MB
   (needs Android SDK 34; in the cloud session it was at `/opt/android-sdk`).
2. Run Food Hub checks again after step 1 (`npm run typecheck && npm run lint && npm test`, webpack build, `npm run verify:foodhub`).
3. Open the PR for `feature/mev-clover-register` (base: `feature/mev-qcmev-integration`), body from this file.
4. On a real **Clover Dev Kit / sandbox merchant** verify: PAYMENT_PROCESSED reaches the app; CloverAuth permissions;
   80 mm print layout; that a Clover refund's `amount` excludes its tip; the Orders webhook fires on payment and refund.
5. Owner (cannot be done by code): create the TAKATAK MEV app in the Clover developer dashboard (App ID/secret/webhook
   code into Coolify env), upload the APK, price/listing. Merge order: QCMEV `fix/backend-readiness` → QCMEV
   `claude/nice-cray-4fhekg` → Food Hub PR #99 → `feature/mev-clover-register`.
6. Revenu Québec (owner): send the SW-10 dossier (`docs/revenu-quebec/REPRISE.md`), get DEV/ESSAI access + SW-73 docs +
   personalized SW-77 cases, then record the official demonstration with `tools/demo-video` pointed at ESSAI.
   Ask RQ in writing whether a Clover-register intake through Food Hub is inside the certified scope.
7. Not built: self-serve onboarding of App Market merchants (today each merchant = a QCMEV operator with its NEQ,
   authorization code and certificate + a Food Hub kitchen code, by hand), KMS/HSM key custody (PROD refused until then).

## Local test recipes (cloud session)
- QCMEV full run: `mkdir -m 777 /var/tmp/qcmev-localrun && QCMEV_LOCAL_DIR=/var/tmp/qcmev-localrun node tools/local-run/run-local.mjs --skip-unit`
  (as root the data folder must be world-writable — embedded PostgreSQL runs initdb as another user).
- Demo stack: `QCMEV_DEMO_DIR=/var/tmp/qcmev-demo-x node tools/demo-video/stack.mjs`, then `record.mjs` (see its README).
- Food Hub e2e: `FOODHUB_E2E_MOCK_PORT=4899 FOODHUB_E2E_APP_PORT=4900 npm run verify:foodhub`.
