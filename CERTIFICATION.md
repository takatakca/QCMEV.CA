# Certification map — Takatak MEV (restaurant sector)

Takatak MEV is **not certified**. This file maps what the code does to the names Revenu Québec uses in its public list
of certified SEVs for restaurants ("Fonctionnalités certifiées"), so the owner can fill the certification request
honestly. Status: **built** = implemented and tested against our local simulator; **partial** = partly built;
**not built** = not offered. Nothing here has been tested in Revenu Québec's DEV or ESSAI environment yet.

## Modes and services

| Revenu Québec name | Status | Notes |
|---|---|---|
| Modes d'opération: remote server (see Revenu Québec's « Administrateur de serveur » page) | built | `APPRLINIT=SRV`; one SEV device per establishment |
| SEV autonome | not built | |
| Service au comptoir | built | `typServ CMP` (phone, website and storefront pickup: SPEC) |
| Livraison par l'exploitant | built | `typServ LVR`, delivery fee line |
| Commande par une plateforme numérique | built | `typServ LVT`, mention « COMMANDE PAR UNE PLATEFORME NUMÉRIQUE » |
| Service aux tables / Indiquer le numéro de table / Indiquer le nombre de clients | partial | `TBL`, `noTabl`, `nbClint` sent; no table workflow in the dashboard |
| Produire une addition (comptoir, tables, livraison, plateforme) | partial | `ADDI` supported by the API; Food Hub sends closing receipts only |
| Camion de restauration, Bar | not built | `acti BAR` and `INC` exist in the code but no bar workflow |

## Transactions and documents

| Revenu Québec name | Status | Notes |
|---|---|---|
| Produire un reçu de fermeture | built | `typTrans RFER`, « PAIEMENT REÇU » |
| Produire une note de crédit | built | `RFER` with negative amounts and a reference, « NOTE DE CRÉDIT » |
| Corriger un reçu de fermeture | partial | correction = credit note + new referenced receipt; « Facture corrigée » mention not printed yet |
| Reproduire une facture | built | `modImpr RPR`, « REPRODUCTION », transmitted |
| Produire un duplicata | built | `modImpr DUP`, « ***COPIE DU COMMERÇANT*** » + « NE PAS REMETTRE AU CLIENT », transmitted |
| Annuler une transaction | partial | full credit note; `modImpr ANN` for an abandoned entry is in the schema, no workflow yet |
| Indiquer qu'un client est parti sans payer | partial | `modImpr PSP` in the schema; no workflow yet |
| Produire des factures en mode Hors ligne | built | signed locally, queued, sent in `transLot`; 48-hour watchdog |
| Utiliser le mode formation | built | `modTrans FOR`, « ***DOCUMENT DE FORMATION*** » |
| Inscrire le pourboire | built | `mont.pourb`, never inside `apresTax` |
| Inscrire les frais de service | built | service-fee line |
| Ajouter des précisions pour un item | partial | modifiers sent as "+" lines (SPEC) |
| Afficher le prix unitaire | built | `unitr` per item |
| Indiquer une vente en commerce électronique | built | `commerElectr O`; cash and cheque refused |
| Déterminer le montant dû / Gérer les paiements par versements | not built | `mtdu`, `versActu`, `versAnt`, `sold` not sent |
| Transférer, répartir ou grouper des items et des factures | not built | |
| Produire une facture contenant une taxe supplémentaire | not built | |
| Numériser un code QR | not built | |

## Taxes and payments

| Revenu Québec name | Status | Notes |
|---|---|---|
| TPS et TVQ combinées / TPS seulement / TVQ seulement / Aucune | built | `FP`, `F`, `P`, `NON`; each tax rounded half-up separately |
| Fourniture non visée par les mesures | partial | `acti NON` |
| Argent comptant, Carte de crédit, Carte de débit, Chèque, Certificat-cadeau, Paiement mixte, Autre, Aucun paiement | built | `ARG`, `CRE`, `DEB`, `CHQ`, `CPR`, `MIX`, `AUT`, `AUC` |
| Coupon, Programme de fidélisation, Porté au compte | not built | codes to confirm (SPEC_GAPS #17) |

## Administration

| Revenu Québec name | Status | Notes |
|---|---|---|
| Gérer les certificats numériques du SEV | partial | CRT `AJO` (ECDSA P-256 CSR) built; renewal / revocation with `noSerie` not yet |
| Gérer les comptes utilisateurs / Gérer plusieurs employés | built | UTL `AJO` / `SUP` / `VAL`; `FOODHUB-AUTO` system user |
| Gérer plusieurs appareils | built | one chain and one numbering per device |
| Produire ou transmettre le rapport de l'utilisateur | built | DOC `RUT`, transmitted every time it is displayed |
| Supports d'impression — Papier / Électronique | built | `formImpr PAP`, `ELE`, `PEL`, `NON`; « Copie électronique » |
| Systèmes d'exploitation | — | server: Linux container (Coolify); dashboard: any browser |

## What only Revenu Québec can give

1. Partner registration (product designer) and the developer identifiers (`IDPARTN`, `IDSEV`, `IDVERSI`), typed by the
   owner into the environment, never into git.
2. SW-73, SW-73.A, SW-73.B, SW-73.D and the personalized SW-77 test cases, to close every item of `SPEC_GAPS.md`.
3. Runs in DEV, then ESSAI (`CASESSAI`), then the certification number (`QCMEV_CERTIFICATION_NUMBER`) and the production
   remote-server authorization code (FO-350.SD) — only then can `MEV_ENVIRONMENT=PROD` start.
4. A written answer on how a Food Hub-type order intake (a terminal of the SEV) must be declared in the certified scope.
