# Reprise backend — mise à jour du 30 octobre 2026

**Code le plus récent : branche `claude/nice-cray-4fhekg`, PR #4** (https://github.com/takatakca/QCMEV.CA/pull/4).
Elle contient tout : `main` (dossier administratif SW-10 et notes), `feature/official-protocol-foodhub` (PR #3),
`fix/backend-readiness` (corrections et preuves du 26 octobre), puis les ventes de la caisse Clover, l’inscription
libre-service, la garde des clés dans Google Cloud KMS et la vidéo de démonstration. Fusionner **la PR #4** suffit :
la PR #3 et `fix/backend-readiness` y sont déjà (la PR #3 a un conflit avec `main` sur `HANDOFF.md` seulement; la PR #4
n’en a aucun). **Aucun déploiement ni migration de données réelles n’a été lancé.**

Lire d’abord `docs/HANDOFF-CLOVER-MEV.md` (état en direct, liste de contrôle, ce qui reste au propriétaire et à
Revenu Québec), puis `READINESS.md`, `CERTIFICATION.md`, `SPEC_GAPS.md` et `docs/revenu-quebec/KEY_CUSTODY.md`.

Résultats vérifiés (simulateur local seulement) : 217 tests unitaires, 25 tests avec PostgreSQL réel, scénarios 13/13,
contrôles Food Hub 40/40 + 2/2, CI de la PR #4 entièrement verte (backend, frontend, images, e2e-simulator).
Côté Food Hub : PR #99 et #100 (takatakca/foodhubca), à jour avec leur `main` le 2026-10-30, `verify:foodhub` 628/0.

**Takatak MEV n’est pas certifié.** Restent : envoi et signatures du dossier SW-10 (préparé dans
`docs/revenu-quebec/`, voir `REPRISE.md` et `ENVOI-ET-SUIVI.md`), documents SW-73 / SW-77 et accès DEV puis ESSAI de
Revenu Québec, cas officiels et certification, trousseau Google Cloud KMS réel (niveau HSM), cible et secrets de
déploiement, essai sur un vrai appareil Clover.

Ne pas utiliser `down -v`, `migrate reset` ou `migrate resolve` pour contourner le précontrôle de migration : préserver
les données par défaut.

Historique (26 octobre) : les corrections avaient été sauvegardées sur `fix/backend-readiness` (code `23824ed`, notes
`239b905`, CI 40410849048 verte), issue du main administratif et de `feature/official-protocol-foodhub` (`903e9db`).

— signé : Claude (session 01QsaHwL) @ Claude Code cloud · 2026-10-30 03:15
