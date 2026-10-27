# Vidéo de démonstration — Takatak MEV (répétition)

**`takatak-mev-demonstration.mp4`** (3 min 08 s, 1280×800, sous-titres français incrustés).

> **Répétition, pas la démonstration officielle.** Enregistrée sur le **simulateur local** de Takatak MEV avec des
> données fictives (NEQ, TPS, TVQ et code d'autorisation de remplissage). Ce n'est pas l'environnement de
> développement (DEV) ni d'essai (ESSAI) de Revenu Québec et elle ne prouve rien quant à la certification. Les cartes
> d'ouverture et de fin le disent.

## Ce que montre la vidéo (vrai tableau de bord, vrai backend, vraie base PostgreSQL)

| # | Scène | Fonction (nom de Revenu Québec) |
|---|---|---|
| 1–3 | Connexion, tableau de bord, appareils | Gérer les utilisateurs (UTL), certificats du SEV (CRT), plusieurs appareils |
| 4–5 | Vente au comptoir, comptant | Produire un reçu de fermeture, mise en page de la facture, code QR, numéro MEV-WEB |
| 6 | Reproduction | Reproduire une facture (RPR) |
| 7 | Copie du commerçant | Produire un duplicata (DUP) |
| 8 | Note de crédit | Produire une note de crédit |
| 9 | Table 12, 2 clients | Service aux tables, numéro de table, nombre de clients, produire une addition |
| 10 | Paiement carte + pourboire | Inscrire le pourboire (hors du total) |
| 11 | Mode formation | Utiliser le mode formation |
| 12 | Facture électronique | Support électronique, lien « Consulter la transaction en ligne » |
| 13–17 | Panne MEV-WEB simulée, puis retour | Produire des factures en mode hors ligne, « PROBLÈME DE COMMUNICATION », transmission en lot |
| 18 | Liste des transactions | Numérotation par appareil |
| 19 | Rapport de l'utilisateur | Produire le rapport de l'utilisateur (DOC RUT) |

Non montré parce que non construit (voir `CERTIFICATION.md`) : versements / montant dû, transfert d'items,
taxe supplémentaire, coupons, ANN / PSP, mode serveur.

## Refaire la vidéo

```sh
npm --prefix backend ci && npm --prefix backend run prisma:generate
npm --prefix frontend ci
npm --prefix tools/local-run ci                 # PostgreSQL intégré
node tools/demo-video/stack.mjs                 # terminal 1 : attendre « READY », noter le dossier affiché
QCMEV_DEMO_DIR=<dossier> node tools/demo-video/record.mjs   # terminal 2 (Playwright + Chromium, ffmpeg pour le MP4)
```

`QCMEV_DEMO_PACE=0.2` fait un essai rapide. Le dossier de travail (base, secrets jetables, journaux, vidéo) est
toujours hors du dépôt.

## Pour la démonstration officielle

Quand Revenu Québec aura fourni l'accès ESSAI et les cas SW-77 personnalisés : pointer le SEV vers ESSAI (identifiants
saisis dans l'environnement, jamais dans git), remplacer les scènes de `tools/demo-video/record.mjs` par ces cas, dans
leur ordre, puis enregistrer. Ne jamais présenter cette répétition comme la démonstration officielle.
