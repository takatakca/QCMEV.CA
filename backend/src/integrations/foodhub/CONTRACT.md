# Food Hub → QCMEV contract `foodhub.sale.v1`

Public document: it contains **no secret, no identity value, no authorization code**. Examples use obvious placeholders.

QCMEV ("Takatak MEV") is the sales recording system (SEV), in mode SEV (`APPRLINIT=SEV`, SW-76 §4.1.2). It is the only
part that numbers, signs, sends to WEB-SRM (MEV-WEB) and lays out the invoice. Food Hub takes the orders like a terminal
of that SEV: it never signs, never talks to Revenu Québec, and prints **only** the exact text and QR code QCMEV returns.

> Status: implemented and tested against QCMEV's **local simulator** only. QCMEV is **not certified**. Conformity can only
> be proven in Revenu Québec's DEV and ESSAI environments with the SW-77 test cases (see `SPEC_GAPS.md`).

## 1. Switches

| Side | Variable | Default | Meaning |
|---|---|---|---|
| QCMEV | `QCMEV_FOODHUB_ENABLED` | `false` | Mounts `/api/v1/integrations/foodhub`. Off = 404. |
| QCMEV | `QCMEV_FOODHUB_SECRET` | — | Shared HMAC secret (≥ 32 random bytes). Required when enabled. |
| QCMEV | `QCMEV_FOODHUB_SECRET_PREVIOUS` | — | Previous secret, accepted during a rotation. |
| QCMEV | `QCMEV_FOODHUB_INTEGRATION_IDS` | `foodhub,on2go_hub` | Accepted `X-Integration-Id` values. |
| QCMEV | `MEV_ENVIRONMENT` | `SIMULATOR` | `SIMULATOR`, `DEV`, `ESSAI`, `PROD` (PROD refused without `QCMEV_CERTIFICATION_NUMBER`). |
| Food Hub | `FOODHUB_MEV` | `off` | `off`, `shadow`, `simulator`, `on`. Food Hub refuses `on` unless `/health` says `environment=PROD` and `certified=true`. |
| Food Hub | `FOODHUB_MEV_URL`, `FOODHUB_MEV_SECRET`, `FOODHUB_MEV_LOCATIONS`, `FOODHUB_MEV_TIMEOUT_MS=8000`, `FOODHUB_MEV_RETRY_S=15,60,300` | | Food Hub side (to build). |

## 2. Transport and authentication

* Coolify internal network only (e.g. `http://qcmev-backend:3001`). The dashboard's public proxy never forwards these routes.
* Same HMAC as Food Hub's `lib/foodhub/tenant.ts` `signContract()`, plus `X-Tenant-Id`:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Integration-Id` | `foodhub` or `on2go_hub` (what `signContract` sends) |
| `X-Tenant-Id` | tenant slug, must equal the body's `tenantId` |
| `X-Event-Id` | `evt_` + `sha256(key + payloadHash)` (deterministic: a retry re-uses it) |
| `X-Timestamp` | Unix time in **seconds** (as `signContract`) or milliseconds |
| `Idempotency-Key` | the `X-Event-Id` (as `signContract`) **or** the body key (`saleKey` / `creditKey` / `printKey`) |
| `X-Signature` | `sha256=` + hex `HMAC_SHA256(secret, "${X-Timestamp}.${X-Event-Id}.${rawBody}")` (raw body = `""` for GET) |

* 5-minute window, constant-time comparison, current **and** previous secret accepted.
* An `X-Event-Id` is remembered (table `IntegrationEvent`): the same id with another body → `409 replay_conflict`.
* No staff JWT on these calls. Rate limit: 20 requests per second per tenant.

## 3. Endpoints (prefix `/api/v1/integrations/foodhub`)

| Method | Path | Body schema | Effect |
|---|---|---|---|
| `POST` | `/sales` | `foodhub.sale.v1` | Closing receipt (`typTrans RFER`, `modImpr FAC`) for a finalized order. |
| `POST` | `/sales/{saleKey}/credit-notes` | `foodhub.credit.v1` | Credit note (`RFER`, negative amounts) referencing the sale. |
| `POST` | `/sales/{saleKey}/prints` | `foodhub.print.v1` | `RPR` reproduction or `DUP` merchant copy, both transmitted. |
| `GET` | `/sales/{saleKey}` | — | Current status and receipt, with its credit notes and prints. |
| `GET` | `/health` | — | `environment`, `certified`, `certificateValidUntil`, `mevReachable`, `queueDepth`, `oldestQueuedAt`, `locations[{locationId, deviceReady, certReady, usersReady}]`. |

`{saleKey}` is URL-encoded.

## 4. Payloads (all money in integer cents, CAD)

### `foodhub.sale.v1`

```json
{
  "schema": "foodhub.sale.v1",
  "tenantId": "takatak",
  "locationId": "KITCHEN_A",
  "saleKey": "fh:takatak:stored:uber_eats:EXAMPLE-ORDER-1",
  "occurredAt": "2026-10-24T23:30:00-04:00",
  "source": { "model": "stored", "channel": "uber_eats", "orderId": "…", "externalOrderId": "…", "displayId": "A1B2", "posOrderId": "…", "brand": "Brand" },
  "serviceType": "LVT",
  "ecommerce": false,
  "user": { "id": "staff-id", "name": "…" },
  "lines": [
    { "ref": "item-1", "description": "Trio poulet", "quantity": "1", "unitPriceCents": 1899, "totalCents": 1899,
      "taxCode": "FP", "activity": "RES",
      "modifiers": [{ "description": "Sauce BBQ", "quantity": "1", "unitPriceCents": 50, "totalCents": 50 }] }
  ],
  "fees": { "deliveryCents": 0, "serviceFeeCents": 0 },
  "discountCents": 0,
  "amounts": { "subtotalCents": 1949, "gstCents": 97, "qstCents": 194, "totalCents": 2240, "tipCents": 0 },
  "payment": { "mode": "AUT", "collectedBy": "platform", "reference": "…" },
  "receipt": { "format": "PAP", "deliver": "print" },
  "testMode": false,
  "referenceSaleKey": "optional: an earlier saleKey this new receipt replaces or completes",
  "payloadHash": "sha256 of the canonical JSON of the body without payloadHash"
}
```

* `channel`: `uber_eats | doordash | skip | tgtg | relay | website | phone | storefront | clover_online | manual`.
* `serviceType`: `LVT` (platform order, picked up or delivered), `LVR` (own delivery), `CMP` (counter / phone / website pickup), `TBL` (tables).
* `taxCode`: `FP | F | P | NON`; `activity`: `RES | BAR | NON`.
* `payment.mode`: `ARG | CHQ | CRE | DEB | CPR | MIX | AUT | INC | AUC`; `collectedBy`: `platform | paylink | clover_tender | cash`.
* `quantity` is a decimal string (max 3 decimals); `totalCents` must equal `quantity × unitPriceCents` (±1 cent).
* Canonical JSON = keys sorted at every level, no whitespace. QCMEV recomputes `payloadHash` and refuses a mismatch.

### `foodhub.credit.v1`

```json
{ "schema": "foodhub.credit.v1", "tenantId": "takatak", "creditKey": "<saleKey>:cn:1",
  "reason": "cancelled | adjusted | missing_items | refund", "full": true,
  "lines": [ "…only when full=false: the credited lines, positive values…" ],
  "amounts": { "subtotalCents": 600, "gstCents": 30, "qstCents": 60 }, "occurredAt": "…", "user": { "id": "…" }, "payloadHash": "…" }
```

* `full: true` credits every line with the taxes **exactly as charged**. `full: false` credits the given lines; taxes are
  computed unless `gstCents` and `qstCents` are both given. The credit can never exceed what remains on the sale.

### `foodhub.print.v1`

```json
{ "schema": "foodhub.print.v1", "tenantId": "takatak", "printKey": "<saleKey>:pr:1", "mode": "RPR | DUP", "payloadHash": "…" }
```

## 5. Mapping rules applied by QCMEV

* `avantTax` = lines + modifiers + **delivery fee only for `LVR`** + service fee − restaurant-funded discount (sent as a
  negative "Rabais" line; SPEC). A delivery fee on a non-`LVR` order is excluded (`warnings: ["deliveryFeeExcluded"]`).
* `amounts.subtotalCents` must equal that sum, and `totalCents = subtotalCents + gstCents + qstCents` exactly.
* TPS / TVQ: transmitted **as charged** (`gstCents`, `qstCents`). When they differ from QCMEV's own computation
  (each tax rounded half-up on its base) by more than 1 cent, `warnings: ["taxGap"]` (Food Hub must compute the taxes of
  Skip "failed" orders whose feed says 0; otherwise WEB-SRM refuses them).
* `pourb` (tip) only when the restaurant keeps it (`CMP`, `LVR`, `TBL`); a tip on `LVT` is dropped (`tipExcluded`). The
  tip is never part of `apresTax`.
* `$0` → payment mode `AUC` (`paymentModeAUC`). `ecommerce: true` → `commerElectr O`, and `ARG` / `CHQ` are refused (422).
  `INC` is accepted only with a `BAR` line.
* `testMode: true` → `modTrans FOR` (receipt shows « ***DOCUMENT DE FORMATION*** »).
* `nomUtil`: the staff member (`user.id` mapped to a QCMEV user `foodhub:<id>` registered with UTL), else `FOODHUB-AUTO`.
* `noTrans` and `datTrans` are assigned by QCMEV at issuance (per device, per civil day, America/Montreal, with `utc`).
  `occurredAt` is stored for audit. Food Hub's `displayId` is printed as free text only.
* `locationId` → operator + SEV device via the `LocationMapping` table (in QCMEV's database, never in git). The
  operator's staff set it in the dashboard (« Appareils » → « Cuisines Food Hub ») or through the staff API (JWT,
  admin / manager): `GET /api/operators/foodhub-locations`, `PUT /api/operators/foodhub-locations`
  `{tenantId, locationId, deviceId}`, `DELETE /api/operators/foodhub-locations/{id}` (the row stays, inactive; the
  location's sales then answer 423). `npm run seed:operator` does the same from a file. Linking also creates the
  operator's `FOODHUB-AUTO` system user (no password, cannot log in) and registers it with UTL as soon as a device is
  certified. A `(tenantId, locationId)` pair belongs to one operator only (another operator → 409).

## 6. Idempotency

* `saleKey = fh:{tenant}:{model}:{channel}:{externalOrderId | direct number}`; `creditKey = {saleKey}:cn:{seq}`;
  `printKey = {saleKey}:pr:{seq}`.
* QCMEV inserts the `ExternalSale` row and the numbered `Transaction` **in one database transaction**, before calling WEB-SRM.
* Same key + same `payloadHash` → the answer is replayed (re-rendered from the stored transaction, so it also shows a later
  acceptance). Same key + different hash → `409 idempotency_conflict`: send a credit note (and, if needed, a new sale with
  `referenceSaleKey`) instead.
* Timeouts are always safe to retry with the same key.

## 7. Answers

| HTTP | Body | Food Hub action |
|---|---|---|
| 200 | `{status: "accepted" \| "offline_pending" \| "rejected", kind, key, saleKey, warnings[], errors[{id, mess, codRetour}], amounts, receipt}` | `accepted`: done. `offline_pending`: receipt valid, QCMEV sends it later. `rejected`: red badge, needs a human. |
| 202 | `{status: "queued", retryAfterS}` | retry later with the same key |
| 401 | `{error: "invalid_signature"}` | alert (secret / clock) |
| 404 | `{error: "sale_not_found"}` | the sale is not issued yet: retry the credit / print later |
| 409 | `{error: "idempotency_conflict" \| "replay_conflict"}` | use the credit-note path |
| 422 | `{error: "validation_failed", errors[{field, message}]}` | no retry, needs a human |
| 423 | `{error: "location_not_ready", field: "locationId" \| "deviceReady" \| "certReady" \| "usersReady"}` | slow retry + alert. `certReady` also means the device's SEV certificate has **expired**: Revenu Québec forbids producing an invoice with it, so nothing is issued until it is renewed (`/health` shows `certReady: false` and `certificateValidUntil`) |
| 429 / 5xx / timeout | | retry with the same key |

WEB-SRM error classes: a `codRetour` ending in 0, 1 or 5 means "not recorded": QCMEV resends it with the next batch
(status stays `offline_pending`). Any other code is a rejection.

### `receipt`

`qcmevTransactionId`, `noTrans`, `datTrans`, `utc`, `deviceId` (IDAPPRL), `mevStatus`, `mevProcessedAt`,
`mevTransactionNumber`, `qr {content, svg, pngDataUrl}`, `mentions[]`, `text80mm[]` (42 columns, exact lines including the
`=====` blocks), `html`, `electronic` (`null`, or for `ELE` / `PEL`: `{mentions[], lines[], html}`),
`renderHash = sha256(text80mm joined by "\n")`, `issuedAt`.

What Food Hub may rely on (and what a Food Hub test stand-in must do the same way):

* `noTrans` is an opaque string. Today QCMEV sends `"1"`, `"2"`, `"3"`… per device and per civil day (no date prefix,
  no padding; the format waits for SW-73). Never parse it; use `qcmevTransactionId` as the unique id.
* `mevTransactionNumber` is MEV-WEB's `psiNoTrans` as received (our simulator: `SIM` + 9 digits), or `null` while
  offline. Never build or parse it.
* A credit note's `mentions` contain « NOTE DE CRÉDIT » (a corrected one « Note de crédit corrigée »), never the
  original's number. The reference to the original is a **text line** of `text80mm`, before the items:
  « Réf. : transaction N » then « du AAAA-MM-JJ hh:mm:ss » on the next line (the same on a corrected receipt).
* `datTrans` of a credit note or a copy (`RPR` / `DUP`) is the moment QCMEV issues it, Montréal civil time with its
  `utc`, like every transaction; never the original's time and never UTC.
* Every `text80mm` line is at most 42 characters, and a line is only broken between words: a long name, address, item
  description or customer name continues on the next line; an item's amount stays on its first line.

Layout (Revenu Québec, SW-76 §4.4.1 and « Exemple de facture – restauration »): name and address, date and number,
items, subtotal, TPS / TVQ registration numbers, payment mode (credit note: « Crédité à : » and « Date de la remise : »),
then a `=` line, TPS, TVQ, TOTAL, tip, the mentions, the line `[CODE QR]` (print the QR there), the processing time
(`mevProcessedAt`), the MEV-WEB number, the device id, and a closing `=` line; « REPRODUCTION » and the merchant-copy
mentions follow it. Offline: the processing time and the MEV-WEB number each read « PROBLÈME DE COMMUNICATION ».
A corrected receipt (`referenceSaleKey` to a credited sale) says « Facture corrigée ».

`text80mm` is the paper document (no link). `electronic.lines` has « Consulter la transaction en ligne » on the line
right after `[CODE QR]`: render it as the hyperlink (`qr.content`) under the QR image; on `PEL` it also says
« Copie électronique ». A terminal shows the electronic document only for `ELE` / `PEL`, and prints each document
once: any further copy is an `RPR` or `DUP` asked through `/prints` (« Modes d'impression »: an invoice is printed or
sent only once).

The receipt text carries the merchant's TPS and TVQ registration numbers, as every invoice does. It never carries the
NEQ, the mandatory-billing file number or the authorization code.

## 8. Offline

* QCMEV unreachable: the order waits in Food Hub's outbox; the kitchen ticket says « FACTURE À VENIR / NE PAS REMETTRE
  AU CLIENT »; Food Hub never makes an invoice itself.
* WEB-SRM unreachable: QCMEV signs locally and answers `offline_pending` with a receipt and a QR; the processing time and
  the MEV-WEB number are each replaced by « PROBLÈME DE COMMUNICATION » (PROVEN); it sends the batch (`transLot`) every `MEV_OFFLINE_FLUSH_SECONDS` once WEB-SRM is back. A network error is
  never stored as a rejection.
* 48-hour legal limit: QCMEV writes a WARNING audit event at 6 h and CRITICAL at 24 h and at 48 h, for the receipts it
  has already signed and is still sending (`offline_pending`).
* Food Hub side (Food Hub `docs/MEV_INTEGRATION.md` §6): a sale or a credit note still waiting in Food Hub's outbox has
  **no invoice at all** (QCMEV has not recorded it), so Food Hub raises a **CRITICAL** alert after **1 minute** pending
  (QCMEV silent, 202, 423, 5xx, not certified…), and at once when it is held for a person (rejected, amounts mismatch…)
  or waits for its payment mode. A copy (`RPR` / `DUP`) waiting is a warning after 15 minutes. A receipt QCMEV signed
  offline (`offline_pending`) raises nothing in Food Hub: that is QCMEV's 48-hour side above.

## 9. Test it locally

`tools/local-run/run-local.mjs` starts an embedded PostgreSQL, the backend with the simulator and runs
`scripts/verify-foodhub-e2e.ts`, which plays Food Hub's role (signed calls, S1–S11 + negative paths) and checks every
signature, the chain and the logs.
