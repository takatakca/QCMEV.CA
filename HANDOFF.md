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
| 1 | Restore offline-sync semantics: add proper offline request type to enum instead of reusing `BATCH_SUBMITTED` | `backend/prisma/schema.prisma`, `backend/src/offline/offline-queue.service.ts` | ⏳ pending |
| 2 | Device model: restore `offlineSince` (distinct from `lastSyncAt`) + device identity fields (`name`, `model`, `firmwareVersion`) | `backend/prisma/schema.prisma`, `backend/src/devices/devices.service.ts` | ⏳ pending |
| 3 | Replace `as unknown as TransactionRequestPayload` cast with runtime validation before submission to RQ | `backend/src/mev-web/mev-web.service.ts` (+ validator helper) | ⏳ pending |
| 4 | Rename migration folder 2024 → 2026, regenerate init SQL from final schema; confirm Docker runs `prisma migrate deploy` | `backend/prisma/migrations/*`, `backend/Dockerfile`, `docker-compose.yml` | ⏳ pending |
| 5 | Operator registration endpoint `POST /api/operators/register` | `backend/src/operators/*` | ⏳ pending |
| 6 | Certificate renewal cron (auto-renew before `validTo`) | `backend/src/certificates/*`, `backend/src/app.module.ts` | ⏳ pending |
| 7 | Full build verification (backend + frontend) | — | ⏳ pending |

### Blocked on outside parties (cannot be done in code)
- SW-77 certification run needs Revenu Québec TESTING credentials
- Final submission to Revenu Québec

## Log
- 2026-10-24 — Session started, repo cloned, HANDOFF.md created.
