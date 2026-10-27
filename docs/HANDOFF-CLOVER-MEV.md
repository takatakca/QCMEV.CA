# HANDOFF — Revenu Québec (QCMEV) + Clover + Food Hub — 2026-10-27

Read this first. Any agent or person can continue from here. Nothing below is merged into `main` (the owner merges).
The same text lives in 3 places, updated together: QCMEV.CA `docs/HANDOFF-CLOVER-MEV.md`, foodhubca
`docs/HANDOFF-CLOVER-MEV.md`, and Google Drive « HANDOFF — QCMEV + Clover + Food Hub — LIVE (…) » (the Drive
connector cannot edit a doc: each update is a new doc with the newest time in its title; older ones say "superseded").
If they differ, GitHub wins.

## LIVE STATUS (newest first — read this line, then continue)
- 2026-10-27 night (3) — **#12 done + 2 real Android bugs fixed** (Food Hub, see `apps/clover-mev-android` log). Clover's
  own rules (docs.clover.com « Set up Android SDK versions », « Generate a signed APK »): targetSdk ≤ 25 and v1-only
  signing. The app targeted 34: (a) from 26 the manifest receiver never gets the implicit PAYMENT_PROCESSED broadcast →
  no automatic print; (b) from 27 the account policy blocks CloverAuth; (c) Clover would refuse the upload. Now
  targetSdk 25; release signed v1 only (`META-INF/CERT.RSA`) with the owner's keystore from env / gradle.properties
  (never in git; `*.jks` ignored); verified with a throwaway key (deleted): `apksigner` v1 true, v2/v3/v4 false.
  Owner steps: `apps/clover-mev-android/README.md` « Release APK ». **Next:** finish the review of the device endpoint
  + Android code, then #7 KMS/HSM design (owner picks the provider).
- 2026-10-27 night (2) — **#14 self-serve onboarding DONE and proven end to end on the simulator.** Docs: Food Hub
  `a3db978`. Checks: Food Hub typecheck, lint 0 errors, 1728 tests, `next build --webpack`, `verify:foodhub` 617/0;
  QCMEV dashboard typecheck, lint, `next build`. Real browser (`tools/demo-video/check-signup.mjs`, QCMEV `483d6bf`):
  sign-up → register enrolled → certificate → code linked → 3 ready flags, 15/15. Then Food Hub's real code against
  that real QCMEV (`tests/mev-qcmev-live.test.ts`, Food Hub `d3797c1`, opt-in): merchant turned on, register sale
  numbered, invoice text + QR for the device, refund → credit note, 2/2. How to rerun: `docs/revenu-quebec/demo/README.md`.
  **Next:** #12 release-signing config for the APK (keystore from env/gradle properties, never in git), then finish the
  review of the device endpoint + Android app, then #7 KMS/HSM key custody design (needs the owner's provider choice).
- 2026-10-27 night — **#14 self-serve onboarding: code done and pushed, docs + build checks in progress.**
  Food Hub `50509e0` (`lib/foodhub/mev/clover-merchants.ts`, gate in `mev/config.ts`, `registerPlace` in
  `clover-register.ts`, welcome page steps, route `POST /api/foodhub/mev/clover-merchant`, 5 tests; full suite
  1728/1728, typecheck + lint clean). QCMEV `cc61264` (dashboard `/register` sign-up page; « Cuisines Food Hub »
  pre-filled; typecheck + lint clean). How it works: approved App Market merchant → welcome page gives it a private code
  `CLV_…` → it signs up in Takatak MEV, adds its Clover register (RQ file number + authorization code), requests the
  certificate, links the code → Food Hub turns it on when QCMEV /health says ready. New env: `FOODHUB_MEV_DASHBOARD_URL`.
  **Next:** docs (`docs/MEV_INTEGRATION.md` § 10, `docs/CLOVER_MULTI_APP.md` § TAKATAK MEV, `.env.example`), then
  `rm -rf .next && npx next build --webpack` and `npm run verify:foodhub`, then the QCMEV dashboard `next build`.
- 2026-10-27 evening — **review pass of my own code, in progress.** Done in it: the Clover register catch-up poll now
  reads oldest change first and resumes after the last order read when it hits its page limit (before: a merchant with
  > 1000 changed orders between two polls could have sales skipped). 2 new tests, 21/21 pass. Commit: see foodhubca
  `feature/mev-clover-register` log. **Next:** finish the review (device endpoint, Android app), release-signing config
  for the APK (keystore stays with the owner), then the open code items in "NOT DONE" step 7.

## IS IT "100 % CERTIFIED"? — honest checklist (owner asked 2026-10-27)
**No. Nobody but Revenu Québec can certify it, and it has not been tested on a real Clover device or in RQ's ESSAI
environment yet.** Do not tell RQ it is "guaranteed error-free": ask for the next step (DEV/ESSAI access, SW-77 cases).

| # | Item | State | Who |
|---|---|---|---|
| 1 | SEV built: official MEV-WEB protocol, ECDSA signing, offline mode, credit notes, RPR/DUP, user report (QCMEV `fix/backend-readiness` + `claude/nice-cray-4fhekg`) | ✅ done, 205 unit tests + full local run green | code |
| 2 | Rehearsal video (simulator, fake data) | ✅ done | code |
| 3 | SW-10 dossier sent to RQ | ❌ not sent | owner |
| 4 | DEV/ESSAI access, SW-73 documents, personalized SW-77 cases | ❌ RQ gives them after step 3 | RQ |
| 5 | SW-77 cases run in ESSAI + official demonstration video | ❌ needs step 4 | code + owner |
| 6 | RQ certification / attestation | ❌ needs step 5 | RQ |
| 7 | Private-key custody in KMS/HSM (PROD is refused without it) | ❌ not built (owner picks the provider) | code + owner |
| 8 | Food Hub sends its sales to QCMEV (PR #99) | ✅ done, 617/617 e2e | code |
| 9 | Clover register sales → invoices (feature/mev-clover-register) | ✅ done, tests green; PR not opened (needs owner OK) | code |
| 10 | TAKATAK MEV Clover app: backend (OAuth, webhook, device endpoint) | ✅ done | code |
| 11 | TAKATAK MEV Android app (prints invoice + QR) | ✅ builds, 8/8 tests; ❌ never run on a real Clover device | code + owner (Dev Kit) |
| 12 | Release-signed APK | ✅ build set up to Clover's rules (v1 only, CERT.RSA, targetSdk 25), checked with a throwaway key; ❌ the owner makes the real key and the upload | code ✅ + owner |
| 13 | App created in the Clover developer dashboard, env in Coolify, APK uploaded, Clover's app review | ❌ | owner |
| 14 | Self-serve onboarding of App Market merchants | ✅ built; proven end to end on the simulator (browser 15/15 + live Food Hub → QCMEV 2/2); ❌ never tried with a real Clover merchant | code + owner |
| 15 | Merged and deployed | ❌ owner merges (order in step 5 below) | owner |

Questions to put to RQ in writing: (a) is a Clover-register intake through Food Hub inside the certified product;
(b) a tip added after the bill is printed (Clover "tip adjust"): today the SEV credits the bill and issues a corrected
one — is that what RQ expects?

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
| `8eec7e5` + `e8cf2c5` | **Android app** `apps/clover-mev-android` (Kotlin; Clover SDK 341 API names verified from the real library); builds, 8/8 tests. README there |
| `0042760` | Catch-up poll never skips a sale on a busy merchant (oldest change first, resumes after the last order read) |
| `50509e0` | **Self-serve onboarding** of App Market merchants (`lib/foodhub/mev/clover-merchants.ts`, welcome page steps) |
Checks after `50509e0`: typecheck, lint 0 errors, 1728 tests (webpack build + `verify:foodhub` to re-run).

### QCMEV.CA — later commits on `claude/nice-cray-4fhekg`
| Commit | What |
|---|---|
| `cc61264` | Dashboard sign-up page `/register`; « Cuisines Food Hub » pre-filled from TAKATAK MEV |

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
7. ~~Self-serve onboarding of App Market merchants~~ **BUILT** (Food Hub `50509e0`, QCMEV `cc61264`): try it end to end
   with one real merchant once deployed. Still not built: KMS/HSM key custody (PROD refused until then; the owner picks
   the provider) and the release-signing config of the APK.

## Local test recipes (cloud session)
- QCMEV full run: `mkdir -m 777 /var/tmp/qcmev-localrun && QCMEV_LOCAL_DIR=/var/tmp/qcmev-localrun node tools/local-run/run-local.mjs --skip-unit`
  (as root the data folder must be world-writable — embedded PostgreSQL runs initdb as another user).
- Demo stack: `QCMEV_DEMO_DIR=/var/tmp/qcmev-demo-x node tools/demo-video/stack.mjs`, then `record.mjs` (see its README).
- Food Hub e2e: `FOODHUB_E2E_MOCK_PORT=4899 FOODHUB_E2E_APP_PORT=4900 npm run verify:foodhub`.
