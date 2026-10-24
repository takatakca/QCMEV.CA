# SPEC gaps — to close when the partner documents arrive

Tags used in the code: **PROVEN** = written in a public Revenu Québec page; **S1** = only seen in Revenu Québec's 2022
sample code; **SPEC** = needs SW-73 / SW-73.A / SW-73.B / SW-73.D / SW-77 or a written answer from Revenu Québec.
Every item below is implemented with a best-known value and marked in the code (`grep -rn "SPEC\|S1" backend/src`).
None of them can be proven with our own simulator.

| # | Item | What the code does today | Where | Source needed |
|---|---|---|---|---|
| 1 | Endpoint URLs for DEV / ESSAI / PROD | No URL is built in: `MEV_WEB_BASE_URL` is required outside the simulator | `config/app-config.ts` | SW-73 |
| 2 | Request paths | `/enrolement`, `/utilisateur`, `/transaction`, `/document` (S1), overridable with `MEV_PATH_*` | `config/app-config.ts` | SW-73 |
| 3 | Header values | Names PROVEN (`ENVIRN`, `CASESSAI`, `APPRLINIT`, `IDAPPRL`, `IDSEV`, `IDVERSI`, `CODCERTIF`, `IDPARTN`, `VERSI`, `VERSIPARN`, `NOTPS`, `NOTVQ`); formats of the version values, and `CODAUTORI`, `SIGNATRANSM`, `EMPRCERTIFTRANSM` (S1) | `mev-web/mev-web.service.ts` | SW-73 |
| 4 | JSON nesting and field order | `reqCertif`, `reqUtil`, `reqTrans{transActu, transLot}`, `reqDoc`; `retour*` answers with `listErr[{id, mess, codRetour}]`, `psiNoTrans`, `psiDatTrans` (S1) | `mev-web/mev-web.types.ts` | SW-73, SW-73.A |
| 5 | Mandatory / optional matrix | Every field we know is always sent | `transactions/trans-builder.ts` | SW-73.A |
| 6 | Signed string | `noTrans + datTrans + TPS + TVQ + apresTax + noTPS + noTVQ + modImpr + modTrans + signa.preced` (S1) | `crypto/ecdsa.ts` | SW-73 |
| 7 | Amount and number formats | Amounts `"12.34"` / `"-12.34"`; `noTrans` = plain sequential number per device per day | `common/money.ts`, `transactions.service.ts` | SW-73.A |
| 8 | CSR subject | `C=CA, ST=QC, L=<utc>, SN=<nickname 8–32>, O=<sector>-<authorization code>, OU=<TVQ>, CN=<NEQ>, GN=<file number>` (S1) | `crypto/csr.ts` | SW-73 / SW-10 |
| 9 | Certificate revocation / renewal | Renewal = CRT `modif REM` + `noSerie` of the current certificate (the 2022 sample shows 40 characters, S1; QCMEV sends the serial as stored), headers signed with the current key (`IDAPPRL`, `EMPRCERTIFTRANSM`, `SIGNATRANSM`), IDAPPRL and signature chain kept; nightly job 03:00 America/Montreal for certificates within `CERT_RENEWAL_DAYS` (30). Revocation: local deactivation only (`SUP` not sent). How long before expiry REM is accepted, and whether an expired certificate may still sign it, are unknown | `certificates.service.ts`, `certificate-lifecycle.service.ts`, `simulator/` | SW-73 |
| 10 | UTL body | `reqUtil{modif AJO/SUP/VAL, nomUtil, noTax=TVQ number}`; users registered on every certified device | `operators/operators.ts` | SW-73 |
| 11 | DOC RUT body | `reqDoc{typDoc RUT, noDossFO, noTPS, noTVQ, annee, datDoc, sommVentes, sommVentesAnt}` | `reports/reports.ts` | SW-73.D |
| 12 | QR code content | `<MEV_QR_BASE_URL>?f=<{a, n, d, m, s} encrypted with MEV-WEB's certificate>` (encryption PROVEN: SW-76 §4.2.1; scheme SPEC: ECDH P-256 + HKDF-SHA256 + AES-256-GCM, or RSA-OAEP-SHA256); the 2022 sample uses a `qr.mev-web.ca` link with an `f` parameter | `crypto/qr-crypto.ts`, `receipts/receipt-renderer.ts` | SW-73.B |
| 13 | Receipt layout | The order of the block is PROVEN (SW-76 §4.4.1, « Exemple de facture »). Still SPEC: the free-text lines (order number, reference), the wording of each label | `receipts/receipt-renderer.ts` | SW-73.B |
| 14 | Invalid-certificate mention | « *** CERTIFICAT INVALIDE *** » (the offline wording « PROBLÈME DE COMMUNICATION » is PROVEN) | `receipts/receipt-renderer.ts` | SW-73.B |
| 26 | Non-exportable SEV key | Software keys (AES-sealed in the database); PROD refused | `config/app-config.ts`, `crypto/csr.ts` | owner decision (KMS / HSM) |
| 15 | Modifiers ("précisions") | Sent as their own lines prefixed with "+" | `trans-builder.ts` | SW-73.A |
| 16 | Restaurant-funded discount | Negative "Rabais" line inside `avantTax` (alternative: `mont.ajus`) | `foodhub.contract.ts` | SW-73.A / RQ answer |
| 17 | Payment codes | `ARG, CHQ, CRE, DEB, CPR, MIX, AUT, INC, AUC`; codes for coupon, loyalty, crypto, e-wallet, transfer, "porté au compte" not offered | `prisma/schema.prisma` | SW-73.A |
| 18 | Platform-collected payments | `AUT` (« autre ») | contract §5 | RQ answer |
| 19 | Phone / website pickup | `typServ CMP` | contract §5 | RQ answer |
| 20 | Reprints and duplicates | Each is a new transaction with its own `noTrans`, same amounts, `refs` to the original | `transactions.service.ts` | SW-73 |
| 21 | Platform fees, courier tips, platform-funded promotions | Excluded (not the restaurant's supply) | contract §5 | RQ answer |
| 22 | `datTrans` of a sale that waited in Food Hub's outbox | QCMEV's issuance time (`occurredAt` kept for audit) | `foodhub.service.ts` | RQ answer |
| 23 | `relaCommer`, `nomMandt`, instalment fields (`versActu`, `versAnt`, `sold`), `ajus`, `mtdu` | Not sent | `mev-web.types.ts` | SW-73.A |
| 24 | MEV-WEB health | No public health endpoint known: `mevReachable` = result of the last real call | `mev-web.service.ts` | SW-73 |
| 25 | The 12 internal scenarios and the SW-77 preparation suite | Ours, not SW-77 (`scripts/run-test-cases.ts`; `backend/test/sw77/sw77-preparation.spec.ts` keeps the core line's SW77-01…12 matrix on the official names); the personalized SW-77 cases must be imported and run in DEV then ESSAI | `scripts/`, `backend/test/sw77/` | SW-77 |
| 27 | Operator self-registration | `POST /api/operators/register` is public (first-time setup), 5 per minute per IP; `QCMEV_PUBLIC_REGISTRATION=false` closes it. Who may create an operator in ESSAI / PROD is a product decision | `operators/operators.ts` | owner decision |
| 28 | Formats checked locally before sending | `mev-web/payload-validator.ts` refuses a stored transaction whose names, codes or formats differ from the known ones (never sent, REJECTED + CRITICAL audit); lengths and the mandatory/optional matrix are not checked yet | `mev-web/payload-validator.ts` | SW-73.A |

When an item is confirmed, fix the code, remove its SPEC / S1 marker, add a unit test, and delete the row.
