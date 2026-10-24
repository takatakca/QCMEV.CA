# HANDOFF — QCMEV.CA work log

> Read this FIRST before doing any work. Every step is committed + pushed
> as it finishes, so the git log and this file are the source of truth.
> Update the status column and the log at the bottom after each step.

## Baseline (start of this session — 2026-10-24)

- Commit `40625e4` — "fix: resolve all TypeScript build errors + add initial Prisma migration"
- `backend` builds clean (`npm run build`, 0 TS errors) per previous session
- Initial migration: `backend/prisma/migrations/20241024000000_init/`

## Task list (priority order)

| # | Task | Files | Status |
|---|------|-------|--------|
| 1 | Offline mode semantics (SW-76 §4.7) — see log | `schema.prisma`, `offline-queue.service.ts`, `transactions.service.ts`, `mev-web.service.ts` | ✅ done |
| 2 | Device model: `offlineSince` + `name`/`model`/`firmwareVersion` | `schema.prisma`, `devices.service.ts` | ✅ done |
| 3 | Runtime validation of TRX payloads (replaces `as unknown as` cast) | `mev-web/payload-validator.ts` (new), `mev-web.service.ts` | ✅ done |
| 4 | Rename migration folder 2024 → 2026, regenerate init SQL from final schema; confirm Docker runs `prisma migrate deploy` | `backend/prisma/migrations/*`, `backend/Dockerfile`, `docker-compose.yml` | ⏳ pending |
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

### Findings to fix next (found while reading, not yet done)
- [ ] **Civil date uses UTC** — `getCivilDate()` in `transactions.service.ts` uses `toISOString()`. A sale at 21:00 in Québec (EDT) gets tomorrow's date. Must use `America/Toronto`. Same for `heureDebut` (`toTimeString()` = container TZ, usually UTC).
- [ ] **`numeroTransactionOriginal` sends our internal UUID** (`relatedTransactionId`) instead of the original's MEV transaction number — affects ANN / COR / NDC.
- [ ] **Tenant isolation:** `devices.controller` update/findById don't check the device belongs to `req.user.operatorId`.
